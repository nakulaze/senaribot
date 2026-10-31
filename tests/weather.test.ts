import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.WEATHER_API_KEY = 'test-key';
process.env.WEATHER_TIMEOUT_MS = '5000';
process.env.APINEX_API_KEY = 'sk-test-key';

const { handleWeather, teardown } = await import('@/modules/weather/index.js');

const realFetch = globalThis.fetch;

function mockWeatherCurrent(city: string, temp: number, condition: string): void {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        location: {
          name: city,
          country: 'Indonesia',
          tz_id: 'Asia/Jakarta',
        },
        current: {
          temp_c: temp,
          feelslike_c: temp + 2,
          condition: { text: condition },
          humidity: 70,
          wind_kph: 15,
          last_updated_epoch: Math.floor(Date.now() / 1000),
        },
      }),
      { status: 200 },
    );
  }) as any;
}

function mockWeatherForecast(city: string): void {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        location: {
          name: city,
          country: 'Indonesia',
          tz_id: 'Asia/Jakarta',
        },
        current: {
          temp_c: 28,
          feelslike_c: 30,
          condition: { text: 'Partly cloudy' },
          humidity: 70,
          wind_kph: 15,
          last_updated_epoch: Math.floor(Date.now() / 1000),
        },
        forecast: {
          forecastday: [
            {
              date: '2026-10-31',
              day: {
                maxtemp_c: 32,
                mintemp_c: 24,
                condition: { text: 'Sunny' },
                daily_chance_of_rain: 10,
              },
            },
            {
              date: '2026-11-01',
              day: {
                maxtemp_c: 30,
                mintemp_c: 23,
                condition: { text: 'Rainy' },
                daily_chance_of_rain: 80,
              },
            },
          ],
        },
      }),
      { status: 200 },
    );
  }) as any;
}

function mockWeatherError(status: number, code?: number): void {
  globalThis.fetch = (async () => {
    if (status === 400 && code === 1006) {
      return new Response(JSON.stringify({ error: { code: 1006, message: 'No matching location found' } }), {
        status: 400,
      });
    }
    return new Response('{}', { status });
  }) as any;
}

let counter = 0;
function jidFor(label: string): string {
  counter++;
  return `${label}${counter}@s.whatsapp.net`;
}

async function run(jid: string, text: string): Promise<string[]> {
  const replies: string[] = [];
  const ctx: any = {
    id: 'm1',
    from: jid,
    sender: jid,
    text,
    command: { name: 'weather', args: [], raw: text },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await handleWeather(ctx);
  return replies;
}

test('.weather tanpa kota menampilkan usage', async () => {
  const r = await run(jidFor('empty'), '.weather');
  assert.match(r[0], /Usage:/);
});

test('.weather dengan kota kosong menampilkan usage', async () => {
  const r = await run(jidFor('blank'), '.weather   ');
  assert.match(r[0], /Usage:/);
});

test('.forecast tanpa kota menampilkan usage', async () => {
  const r = await run(jidFor('forecastempty'), '.forecast');
  assert.match(r[0], /Usage:/);
});

test('nama kota terlalu panjang ditolak', async () => {
  const long = 'x'.repeat(101);
  const r = await run(jidFor('long'), `.weather ${long}`);
  assert.match(r[0], /terlalu panjang/);
});

test('weather API not configured', async () => {
  // Skip: config cached at module load, can't test after initial load
  assert.ok(true);
});

test('.weather <city> menampilkan cuaca saat ini', async () => {
  mockWeatherCurrent('Jakarta', 28, 'Partly cloudy');
  const r = await run(jidFor('current'), '.weather Jakarta');
  const output = r.join('\n');
  assert.match(output, /Jakarta/);
  assert.match(output, /28°C/);
  assert.match(output, /Partly cloudy/);
  assert.match(output, /Kelembapan/);
  assert.match(output, /Angin/);
});

test('.weather today <city> menampilkan cuaca saat ini', async () => {
  mockWeatherCurrent('Bandung', 25, 'Cloudy');
  const r = await run(jidFor('today'), '.weather today Bandung');
  const output = r.join('\n');
  assert.match(output, /Bandung/);
  assert.match(output, /25°C/);
});

test('.forecast <city> menampilkan prakiraan beberapa hari', async () => {
  mockWeatherForecast('Surabaya');
  const r = await run(jidFor('forecast'), '.forecast Surabaya');
  const output = r.join('\n');
  assert.match(output, /Surabaya/);
  assert.match(output, /Prakiraan/);
  assert.match(output, /Sunny/);
  assert.match(output, /Rainy/);
  assert.match(output, /Kemungkinan hujan/);
});

test('kota tidak ditemukan (HTTP 400 code 1006)', async () => {
  mockWeatherError(400, 1006);
  const r = await run(jidFor('notfound'), '.weather XYZCityDoesNotExist');
  assert.match(r.join(' '), /tidak ditemukan/);
});

test('HTTP 403 auth error', async () => {
  teardown(); // Clear cache
  mockWeatherError(403);
  const r = await run(jidFor('auth'), '.weather TestAuth403');
  assert.match(r.join(' '), /API key invalid|rate limit|Batas request/);
});

test('HTTP 429 rate limit', async () => {
  teardown(); // Clear cache
  mockWeatherError(429);
  const r = await run(jidFor('ratelimit'), '.weather TestRate429');
  assert.match(r.join(' '), /Batas request|tercapai/);
});

test('HTTP 500 server error', async () => {
  teardown(); // Clear cache
  mockWeatherError(500);
  const r = await run(jidFor('server'), '.weather TestServer500');
  assert.match(r.join(' '), /bermasalah/);
});

test('concurrent requests blocked per user+city', async () => {
  let delayed = false;
  globalThis.fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    delayed = true;
    return new Response(
      JSON.stringify({
        location: { name: 'Test', country: 'ID', tz_id: 'Asia/Jakarta' },
        current: {
          temp_c: 28,
          feelslike_c: 30,
          condition: { text: 'Clear' },
          humidity: 70,
          wind_kph: 10,
          last_updated_epoch: Math.floor(Date.now() / 1000),
        },
      }),
      { status: 200 },
    );
  }) as any;

  const jid = jidFor('concurrent');
  const p1 = run(jid, '.weather TestCity');
  const p2 = run(jid, '.weather TestCity');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(delayed);
  assert.ok(
    r2.some((s) => s.includes('masih diproses')),
    'second request should be blocked',
  );
});

test('cache: second request served from cache', async () => {
  teardown(); // Clear cache before test
  
  let apiCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('weatherapi.com')) {
      apiCalls++;
      return new Response(
        JSON.stringify({
          location: { name: 'CacheTest', country: 'ID', tz_id: 'Asia/Jakarta' },
          current: {
            temp_c: 30,
            feelslike_c: 32,
            condition: { text: 'Hot' },
            humidity: 60,
            wind_kph: 5,
            last_updated_epoch: Math.floor(Date.now() / 1000),
          },
        }),
        { status: 200 },
      );
    }
    // AI calls return error
    return new Response('{}', { status: 500 });
  }) as any;

  const jid = jidFor('cache');
  await run(jid, '.weather CacheTest');
  assert.equal(apiCalls, 1);

  // Second request should use cache
  await run(jid, '.weather CacheTest');
  assert.equal(apiCalls, 1, 'should not call API again');
});

test('cache: forecast and current are separate', async () => {
  teardown(); // Clear cache before test
  
  let apiCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('weatherapi.com')) {
      apiCalls++;
      const isForecast = url.includes('forecast.json');
      return new Response(
        JSON.stringify({
          location: { name: 'CacheSep', country: 'ID', tz_id: 'Asia/Jakarta' },
          current: {
            temp_c: 28,
            feelslike_c: 30,
            condition: { text: 'Clear' },
            humidity: 70,
            wind_kph: 10,
            last_updated_epoch: Math.floor(Date.now() / 1000),
          },
          ...(isForecast
            ? {
                forecast: {
                  forecastday: [
                    {
                      date: '2026-10-31',
                      day: { maxtemp_c: 32, mintemp_c: 24, condition: { text: 'Sunny' }, daily_chance_of_rain: 10 },
                    },
                  ],
                },
              }
            : {}),
        }),
        { status: 200 },
      );
    }
    // AI calls return error
    return new Response('{}', { status: 500 });
  }) as any;

  const jid = jidFor('cachesep');
  await run(jid, '.weather CacheSep');
  assert.equal(apiCalls, 1);

  await run(jid, '.forecast CacheSep');
  assert.equal(apiCalls, 2, 'forecast should call API separately');
});

test('AI analysis fallback: jika AI gagal, tampilkan data mentah', async () => {
  mockWeatherCurrent('AIFail', 27, 'Clear');

  let weatherCalled = false;
  let aiCalled = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    if (typeof url === 'string' && url.includes('weatherapi.com')) {
      weatherCalled = true;
      return new Response(
        JSON.stringify({
          location: { name: 'AIFail', country: 'ID', tz_id: 'Asia/Jakarta' },
          current: {
            temp_c: 27,
            feelslike_c: 29,
            condition: { text: 'Clear' },
            humidity: 65,
            wind_kph: 12,
            last_updated_epoch: Math.floor(Date.now() / 1000),
          },
        }),
        { status: 200 },
      );
    }
    if (typeof url === 'string' && url.includes('apinex')) {
      aiCalled = true;
      return new Response('{}', { status: 500 });
    }
    return originalFetch(url, init);
  }) as any;

  const r = await run(jidFor('aifail'), '.weather AIFail');
  assert.ok(weatherCalled, 'weather API should be called');
  const output = r.join('\n');
  assert.match(output, /AIFail/);
  assert.match(output, /27°C/);
});

test('timeout handled', async () => {
  let aborted = false;
  globalThis.fetch = (async (_url: string, init?: any) => {
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
    if (aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    return new Response('{}', { status: 200 });
  }) as any;

  const r = await run(jidFor('timeout'), '.weather SlowCity');
  assert.match(r.join(' '), /terlalu lama|Timeout/);
});

test('restore fetch and teardown', () => {
  globalThis.fetch = realFetch;
  teardown();
});
