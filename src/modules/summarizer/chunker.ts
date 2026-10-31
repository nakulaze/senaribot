/**
 * Pecah teks menjadi potongan <= maxChars. Prioritas titik potong:
 * paragraf (\n\n) > baris (\n) > akhir kalimat > spasi > potong paksa.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (maxChars < 1) throw new Error('maxChars harus >= 1');

  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const min = Math.floor(maxChars * 0.5);

    let cut = window.lastIndexOf('\n\n');
    if (cut < min) cut = window.lastIndexOf('\n');
    if (cut < min) {
      const sentence = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
      );
      cut = sentence >= min ? sentence + 1 : -1;
    }
    if (cut < min) cut = window.lastIndexOf(' ');
    if (cut < min) cut = maxChars;

    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}
