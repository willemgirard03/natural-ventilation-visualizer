// Reads EnergyPlus .eso results text, whole or in chunks (results files run to 150 MB, so the
// browser streams them). A variable can be reported at several frequencies, so each series is
// keyed "KEY|Variable name|Frequency". `keep(key, variable, frequency)` chooses which to store.

export class EsoParser {
  constructor(keep = () => true) {
    this.keep = keep;
    this.names = new Map();
    this.series = new Map();
    this.inData = false;
    this.rest = '';
  }

  push(chunk) {
    const text = this.rest + chunk;
    let start = 0, nl;
    while ((nl = text.indexOf('\n', start)) >= 0) {
      this.line(text.slice(start, nl).replace(/\r$/, ''));
      start = nl + 1;
    }
    this.rest = text.slice(start);
  }

  finish() {
    if (this.rest) this.line(this.rest);
    this.rest = '';
    return { series: this.series, find: (variable, key, frequency = 'TimeStep') => this.series.get(`${String(key).toUpperCase()}|${variable}|${frequency}`) };
  }

  line(l) {
    const c = l.indexOf(',');
    if (!this.inData) {
      if (l.startsWith('End of Data Dictionary')) { this.inData = true; return; }
      const m = l.match(/^(\d+),\d+,([^,]*),([^[!]+?)\s*(?:\[[^\]]*\])?\s*!\s*(\w+)/);
      if (m && Number(m[1]) > 6 && this.keep(m[2].toUpperCase(), m[3].trim(), m[4])) {
        const name = `${m[2].toUpperCase()}|${m[3].trim()}|${m[4]}`;
        this.names.set(m[1], name);
        this.series.set(name, []);
      }
      return;
    }
    if (c < 0) return;
    const name = this.names.get(l.slice(0, c));
    if (name) this.series.get(name).push(Number(l.slice(c + 1).split(',')[0]));
  }
}

export function parseEso(text, keep) {
  const p = new EsoParser(keep);
  p.push(text);
  return p.finish();
}

// Streams a ReadableStream of bytes (a File's or a fetch response's) through the parser.
export async function readEsoStream(stream, keep, onProgress = () => {}) {
  const p = new EsoParser(keep), decoder = new TextDecoder();
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    p.push(decoder.decode(value, { stream: true }));
    onProgress(bytes);
  }
  p.push(decoder.decode());
  return p.finish();
}
