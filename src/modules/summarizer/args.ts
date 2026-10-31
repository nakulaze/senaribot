export type SummaryStyle = 'short' | 'detailed' | 'bullets' | 'executive';

export const DEFAULT_STYLE: SummaryStyle = 'detailed';

const STYLE_ALIASES: Record<string, SummaryStyle> = {
  short: 'short',
  singkat: 'short',
  detailed: 'detailed',
  detail: 'detailed',
  lengkap: 'detailed',
  bullets: 'bullets',
  bullet: 'bullets',
  poin: 'bullets',
  executive: 'executive',
  exec: 'executive',
  eksekutif: 'executive',
};

export interface ParsedSummarizeArgs {
  style: SummaryStyle;
  styleExplicit: boolean;
  text: string;
}

/** Parse ".summarize [gaya] [teks]" tanpa menghilangkan baris baru pada teks. */
export function parseSummarizeArgs(raw: string, prefix: string): ParsedSummarizeArgs {
  let rest = raw.trim();
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  rest = rest.replace(/^\s*\S+/, '').replace(/^[ \t]+/, '');

  const m = rest.match(/^(\S+)/);
  const style = m ? STYLE_ALIASES[m[1].toLowerCase()] : undefined;
  if (style && m) rest = rest.slice(m[1].length);

  return { style: style ?? DEFAULT_STYLE, styleExplicit: Boolean(style), text: rest.trim() };
}
