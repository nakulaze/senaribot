import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('github');
const config = getConfig();

const CACHE_TTL_MS = 600000; // 10 minutes
const inFlight = new Set<string>();

interface CacheEntry<T> {
  data: T;
  expires: number;
}

const cache = new Map<string, CacheEntry<any>>();

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  default_branch: string;
}

interface GitHubUser {
  login: string;
  name: string | null;
  bio: string | null;
  html_url: string;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  user: {
    login: string;
  };
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
  html_url: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
}

class GitHubError extends Error {
  constructor(
    public kind: 'not_found' | 'rate_limit' | 'network' | 'server' | 'unauthorized',
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

function getCacheKey(type: string, key: string): string {
  return `${type}:${key}`;
}

function getFromCache<T>(type: string, key: string): T | null {
  const cacheKey = getCacheKey(type, key);
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(cacheKey);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(type: string, key: string, data: T): void {
  const cacheKey = getCacheKey(type, key);
  cache.set(cacheKey, {
    data,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

async function fetchGitHub<T>(endpoint: string): Promise<T> {
  const cached = getFromCache<T>('fetch', endpoint);
  if (cached) {
    log.debug('github cache hit for %s', endpoint);
    return cached;
  }

  let timer: NodeJS.Timeout | null = null;
  const controller = new AbortController();

  try {
    const url = `https://api.github.com${endpoint}`;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Senaribot',
    };

    if (config.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${config.GITHUB_TOKEN}`;
    }

    timer = setTimeout(() => controller.abort(), config.GITHUB_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);
    timer = null;

    if (res.status === 404) {
      throw new GitHubError('not_found', 'Repository atau user tidak ditemukan');
    }

    if (res.status === 401) {
      throw new GitHubError('unauthorized', 'Token GitHub tidak valid');
    }

    if (res.status === 403) {
      const rateLimitRemaining = res.headers.get('X-RateLimit-Remaining');
      if (rateLimitRemaining === '0') {
        throw new GitHubError('rate_limit', 'Rate limit GitHub tercapai');
      }
      throw new GitHubError('unauthorized', 'Akses ditolak');
    }

    if (res.status >= 500) {
      throw new GitHubError('server', 'GitHub server error');
    }

    if (!res.ok) {
      throw new GitHubError('network', `HTTP ${res.status}`);
    }

    const data = await res.json();
    setCache('fetch', endpoint, data);
    return data as T;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error instanceof GitHubError) throw error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new GitHubError('network', 'Timeout');
      }
      if (error.message.includes('fetch')) {
        throw new GitHubError('network', 'Network error');
      }
    }
    log.warn('github fetch failed: %s', error instanceof Error ? error.message : 'unknown');
    throw new GitHubError('network', 'Network error');
  }
}

function formatRepo(repo: GitHubRepo): string {
  const lines = [
    `📦 ${repo.full_name}`,
    '',
    repo.description || 'Tidak ada deskripsi',
    '',
    `⭐ ${repo.stargazers_count.toLocaleString('id-ID')} stars`,
    `🍴 ${repo.forks_count.toLocaleString('id-ID')} forks`,
    `📋 ${repo.open_issues_count} open issues`,
  ];

  if (repo.language) {
    lines.push(`💻 ${repo.language}`);
  }

  lines.push('');
  lines.push(`🔗 ${repo.html_url}`);

  return lines.join('\n');
}

function formatUser(user: GitHubUser): string {
  const lines = [
    `👤 ${user.name || user.login}`,
    `@${user.login}`,
    '',
  ];

  if (user.bio) {
    lines.push(user.bio);
    lines.push('');
  }

  lines.push(`📚 ${user.public_repos} repositories`);
  lines.push(`👥 ${user.followers.toLocaleString('id-ID')} followers · ${user.following.toLocaleString('id-ID')} following`);
  lines.push('');
  lines.push(`🔗 ${user.html_url}`);

  return lines.join('\n');
}

function formatIssues(issues: GitHubIssue[], repoName: string): string {
  if (issues.length === 0) {
    return `📋 Tidak ada open issues di ${repoName}`;
  }

  const lines = [
    `📋 Open Issues: ${repoName}`,
    '',
  ];

  for (const issue of issues.slice(0, 5)) {
    lines.push(`#${issue.number} ${issue.title}`);
    lines.push(`   by @${issue.user.login}`);
    lines.push(`   ${issue.html_url}`);
    lines.push('');
  }

  if (issues.length > 5) {
    lines.push(`... dan ${issues.length - 5} issues lainnya`);
  }

  return lines.join('\n');
}

function formatCommits(commits: GitHubCommit[], repoName: string): string {
  if (commits.length === 0) {
    return `📝 Tidak ada commits di ${repoName}`;
  }

  const lines = [
    `📝 Recent Commits: ${repoName}`,
    '',
  ];

  for (const commit of commits.slice(0, 5)) {
    const message = commit.commit.message.split('\n')[0]; // first line only
    const shortSha = commit.sha.substring(0, 7);
    lines.push(`${shortSha} ${message}`);
    lines.push(`   by ${commit.commit.author.name}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatReleases(releases: GitHubRelease[], repoName: string): string {
  if (releases.length === 0) {
    return `🎉 Tidak ada releases di ${repoName}`;
  }

  const lines = [
    `🎉 Releases: ${repoName}`,
    '',
  ];

  for (const release of releases.slice(0, 3)) {
    lines.push(`${release.tag_name} ${release.name || ''}`);
    if (release.body) {
      const bodyPreview = release.body.split('\n').slice(0, 2).join('\n');
      lines.push(`   ${bodyPreview}`);
    }
    lines.push(`   ${release.html_url}`);
    lines.push('');
  }

  if (releases.length > 3) {
    lines.push(`... dan ${releases.length - 3} releases lainnya`);
  }

  return lines.join('\n');
}

function friendlyGitHubError(error: unknown): string {
  if (error instanceof GitHubError) {
    switch (error.kind) {
      case 'not_found':
        return error.message;
      case 'rate_limit':
        return 'Rate limit GitHub tercapai. Tunggu beberapa saat atau gunakan GITHUB_TOKEN.';
      case 'unauthorized':
        return error.message;
      case 'network':
        return error.message === 'Timeout'
          ? 'Request terlalu lama. Coba lagi.'
          : 'Tidak dapat terhubung ke GitHub. Coba lagi nanti.';
      case 'server':
        return 'GitHub server sedang bermasalah. Coba lagi nanti.';
      default:
        return 'Terjadi kesalahan. Coba lagi.';
    }
  }
  return 'Terjadi kesalahan. Coba lagi.';
}

async function handleGitHubRepo(ctx: DispatchContext, repoPath: string): Promise<void> {
  try {
    const repo = await fetchGitHub<GitHubRepo>(`/repos/${repoPath}`);
    await ctx.reply(formatRepo(repo));
  } catch (error) {
    log.warn('github repo failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyGitHubError(error));
  }
}

async function handleGitHubUser(ctx: DispatchContext, username: string): Promise<void> {
  try {
    const user = await fetchGitHub<GitHubUser>(`/users/${username}`);
    await ctx.reply(formatUser(user));
  } catch (error) {
    log.warn('github user failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyGitHubError(error));
  }
}

async function handleGitHubIssues(ctx: DispatchContext, repoPath: string): Promise<void> {
  try {
    const issues = await fetchGitHub<GitHubIssue[]>(`/repos/${repoPath}/issues?state=open&per_page=10`);
    await ctx.reply(formatIssues(issues, repoPath));
  } catch (error) {
    log.warn('github issues failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyGitHubError(error));
  }
}

async function handleGitHubCommits(ctx: DispatchContext, repoPath: string): Promise<void> {
  try {
    const commits = await fetchGitHub<GitHubCommit[]>(`/repos/${repoPath}/commits?per_page=5`);
    await ctx.reply(formatCommits(commits, repoPath));
  } catch (error) {
    log.warn('github commits failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyGitHubError(error));
  }
}

async function handleGitHubReleases(ctx: DispatchContext, repoPath: string): Promise<void> {
  try {
    const releases = await fetchGitHub<GitHubRelease[]>(`/repos/${repoPath}/releases?per_page=5`);
    await ctx.reply(formatReleases(releases, repoPath));
  } catch (error) {
    log.warn('github releases failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyGitHubError(error));
  }
}

export async function handleGitHub(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);

  if (parts.length < 2) {
    await ctx.reply(
      'Senaribot GitHub Integration\n\nCommands:\n.github repo <owner>/<repo>\n.github user <username>\n.github issues <owner>/<repo>\n.github commits <owner>/<repo>\n.github releases <owner>/<repo>',
    );
    return;
  }

  const subcommand = parts[1].toLowerCase();
  const arg = parts[2];

  if (!arg) {
    await ctx.reply('Argument required. Example: .github repo nakulaze/senaribot');
    return;
  }

  const requestKey = `${ctx.sender}:${subcommand}:${arg}`;
  if (inFlight.has(requestKey)) {
    await ctx.reply('Request sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(requestKey);

  try {
    switch (subcommand) {
      case 'repo':
      case 'repository':
        await handleGitHubRepo(ctx, arg);
        break;
      case 'user':
        await handleGitHubUser(ctx, arg);
        break;
      case 'issues':
        await handleGitHubIssues(ctx, arg);
        break;
      case 'commits':
        await handleGitHubCommits(ctx, arg);
        break;
      case 'releases':
        await handleGitHubReleases(ctx, arg);
        break;
      default:
        await ctx.reply('Subcommand tidak dikenal. Gunakan: repo, user, issues, commits, releases');
    }
  } catch (error) {
    log.warn('github handler error: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyGitHubError(error));
  } finally {
    inFlight.delete(requestKey);
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'github',
      aliases: ['gh'],
      description: 'GitHub integration - repo info, user, issues, commits, releases',
      handler: handleGitHub,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
  cache.clear();
}
