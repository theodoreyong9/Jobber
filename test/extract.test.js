import { test } from 'node:test';
import assert from 'node:assert/strict';

// extract.js's DOCX path uses the browser's DOMParser, which Node doesn't
// have. This is a small, self-contained stand-in — good enough for the
// well-formed, attribute-free XML fixture below — used only in this test
// file so the ZIP-reading logic in extract.js runs completely unmodified.
function installFakeDOMParser() {
  function parse(xml) {
    let i = xml.indexOf('<'); // skip any leading declaration handling below
    while (xml.startsWith('<?', i)) i = xml.indexOf('?>', i) + 2;
    while (xml[i] !== '<') i++;

    function parseNode() {
      i++; // consume '<'
      const tagEnd = xml.indexOf('>', i);
      const tag = xml.slice(i, tagEnd);
      i = tagEnd + 1;
      const node = { tag, children: [], text: '' };
      for (;;) {
        if (xml.startsWith('</', i)) { i = xml.indexOf('>', i) + 1; break; }
        if (xml[i] === '<') { node.children.push(parseNode()); continue; }
        const nextLt = xml.indexOf('<', i);
        node.text += xml.slice(i, nextLt);
        i = nextLt;
      }
      node.getElementsByTagName = (name) => collect(node, name);
      Object.defineProperty(node, 'textContent', {
        get() { return node.text + node.children.map((c) => c.textContent).join(''); },
      });
      return node;
    }
    function collect(node, name) {
      let out = [];
      for (const c of node.children) {
        if (c.tag === name) out.push(c);
        out = out.concat(collect(c, name));
      }
      return out;
    }
    return parseNode();
  }

  global.DOMParser = class {
    parseFromString(xml) {
      const root = parse(xml);
      return { querySelector: () => null, getElementsByTagName: (name) => root.getElementsByTagName(name) };
    }
  };
}
installFakeDOMParser();

const { extractDocxText } = await import('../js/extract.js');

// Minimal CompressionStream-based deflate-raw compressor, mirroring what a
// real ZIP writer would produce, so this test exercises the exact same
// inflate path extract.js uses in the browser.
async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Builds a tiny but structurally real ZIP file containing one entry.
async function buildZip(entryName, contentBytes) {
  const compressed = await deflateRaw(contentBytes);
  const nameBytes = new TextEncoder().encode(entryName);
  const crc = crc32(contentBytes);

  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);   // version needed
  local.writeUInt16LE(0, 6);    // flags
  local.writeUInt16LE(8, 8);    // method: deflate
  local.writeUInt16LE(0, 10);   // mod time
  local.writeUInt16LE(0, 12);   // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contentBytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  Buffer.from(nameBytes).copy(local, 30);

  const localOffset = 0;
  const fileSection = Buffer.concat([local, Buffer.from(compressed)]);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contentBytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(localOffset, 42);
  Buffer.from(nameBytes).copy(central, 46);

  const centralOffset = fileSection.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([fileSection, central, eocd]);
}

function fakeDocxWordXml(paragraphs) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('');
  return `<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>${body}</w:body></w:document>`;
}

test('extractDocxText reads text back out of a real ZIP/XML structure', async () => {
  const xml = fakeDocxWordXml(['Hello world', 'Second paragraph']);
  const zipBuffer = await buildZip('word/document.xml', new TextEncoder().encode(xml));

  // Minimal File-like object with the arrayBuffer() method extractDocxText needs.
  const fakeFile = { arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength) };

  const text = await extractDocxText(fakeFile);
  assert.ok(text.includes('Hello world'));
  assert.ok(text.includes('Second paragraph'));
});

test('extractDocxText throws a clear error for a non-ZIP file', async () => {
  const fakeFile = { arrayBuffer: async () => new TextEncoder().encode('not a zip').buffer };
  await assert.rejects(() => extractDocxText(fakeFile), /valid \.docx/);
});
