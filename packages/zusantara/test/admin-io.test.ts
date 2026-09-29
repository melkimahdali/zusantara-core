import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { parseCsv, toCsv } from "../src/admin/csv.js";
import { readXlsx } from "../src/admin/xlsx.js";

describe("csv", () => {
  it("round-trip kutip, koma, kutip ganda, dan baris baru", () => {
    const rows = [
      ["nama", "catatan"],
      ["Budi, S.Kom", 'kata "halo"'],
      ["baris\r\nbaru", " spasi "],
    ];
    const text = toCsv(rows);
    assert.ok(text.startsWith("﻿"));
    assert.ok(text.endsWith("\r\n"));
    assert.deepEqual(parseCsv(text), rows);
  });

  it("mendeteksi pemisah ; dan tab", () => {
    assert.deepEqual(parseCsv("a;b;\"c;d\"\n1;2,5;3\n"), [["a", "b", "c;d"], ["1", "2,5", "3"]]);
    assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv('"x;y",b,c\n1,2,3'), [["x;y", "b", "c"], ["1", "2", "3"]]);
  });

  it("membuang BOM, menangani CR/LF/CRLF, dan baris kosong di akhir", () => {
    assert.deepEqual(parseCsv("﻿a,b\r\n1,2\r3,4\n5,6\r\n\r\n,\r\n"), [["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
    assert.deepEqual(parseCsv('a,"x\r\ny"\r\n'), [["a", "x\r\ny"]]);
    assert.deepEqual(parseCsv(""), []);
  });

  it("mengubah tipe nilai dan memakai opsi", () => {
    const d = new Date("2024-10-01T00:00:00.000Z");
    assert.equal(toCsv([[d, null, undefined, { a: 1 }, 5, true]], { bom: false }), '2024-10-01T00:00:00.000Z,,,"{""a"":1}",5,true\r\n');
    assert.equal(toCsv([["a;b", "c"]], { delimiter: ";", bom: false }), '"a;b";c\r\n');
    assert.equal(toCsv([], { bom: false }), "");
  });

  it("melindungi dari injeksi rumus, tapi angka negatif tetap", () => {
    const out = toCsv([["=SUM(A1)", "+1+1", "-cmd", "@x", "\tx", "-12", "-1.5", -3, "a=b"]], { bom: false });
    assert.equal(out, "'=SUM(A1),'+1+1,'-cmd,'@x,'\tx,-12,-1.5,-3,a=b\r\n");
  });
});

// --- Pembuat ZIP kecil untuk fixture .xlsx ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: Record<string, string>, deflate: string[] = []): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(content);
    const method = deflate.includes(name) ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbookFiles(sheetXml: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${NS} ${RNS}><sheets><sheet name="Data &amp; Info" sheetId="1" r:id="rId1"/><sheet name="Lain" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst ${NS} count="3" uniqueCount="3"><si><t>Nama</t></si><si><r><rPr><b/></rPr><t>Kaya</t></r><r><t xml:space="preserve"> teks</t></r></si><si><t>A &amp; B &lt;c&gt; &#233;&#x41;</t></si></sst>`,
    "xl/styles.xml": `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="165" formatCode="0.00&quot; dm&quot;"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": sheetXml,
    "xl/worksheets/sheet2.xml": `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>salah</t></is></c></row></sheetData></worksheet>`,
    ...extra,
  };
}

const SHEET = `<?xml version="1.0"?><worksheet ${NS}><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2"><v>42.5</v></c><c r="B2" s="1"><v>45566</v></c><c r="C2" s="2"><v>45566.5</v></c><c r="D2" s="3"><v>7</v></c></row>
<row r="4"><c r="B4" t="b"><v>1</v></c><c r="C4" t="b"><v>0</v></c><c r="D4" t="inlineStr"><is><t>x &quot;y&quot; &apos;z&apos;</t></is></c></row>
<row r="5"><c r="A5" t="s"><v>2</v></c><c r="B5" t="str"><f>A1&amp;"!"</f><v>Nama!</v></c></row>
<row r="6"><c r="A6" s="1"/></row>
</sheetData></worksheet>`;

describe("xlsx", () => {
  it("membaca lembar pertama dengan semua tipe sel", () => {
    const { sheets, rows } = readXlsx(zip(workbookFiles(SHEET)));
    assert.deepEqual(sheets, ["Data & Info", "Lain"]);
    assert.deepEqual(rows, [
      ["Nama", "", "Kaya teks", ""],
      ["42.5", "2024-10-01", "2024-10-01T12:00", "7"],
      ["", "", "", ""],
      ["", "true", "false", `x "y" 'z'`],
      ["A & B <c> éA", "Nama!", "", ""],
    ]);
  });

  it("membaca entri terkompresi deflate dan sistem tanggal 1904", () => {
    const files = workbookFiles(SHEET);
    files["xl/workbook.xml"] = files["xl/workbook.xml"]!.replace("<sheets>", '<workbookPr date1904="1"/><sheets>');
    const { rows } = readXlsx(zip(files, ["xl/worksheets/sheet1.xml", "xl/sharedStrings.xml", "xl/workbook.xml"]));
    assert.equal(rows[0]![0], "Nama");
    assert.equal(rows[1]![1], "2028-10-02");
  });

  it("menolak file yang bukan .xlsx", () => {
    assert.throws(() => readXlsx(new TextEncoder().encode("nama,umur\nBudi,30\n")), /Bukan file Excel .xlsx yang valid/);
    assert.throws(() => readXlsx(new Uint8Array(0)), /Bukan file Excel/);
    assert.throws(() => readXlsx(zip({ "a.txt": "halo" })), /Bukan file Excel/);
  });

  it("menolak file terlalu banyak baris", () => {
    const big = `<worksheet ${NS}><sheetData><row r="100001"><c r="A100001"><v>1</v></c></row></sheetData></worksheet>`;
    assert.throws(() => readXlsx(zip(workbookFiles(big))), /terlalu banyak baris/);
  });
});
