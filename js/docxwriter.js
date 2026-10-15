// Document model -> .docx (WordprocessingML) using JSZip. No external docx library.
import { escapeXml } from './util.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const twips = (pt) => Math.round(pt * 20);
const emu = (pt) => Math.round(pt * 12700);
const half = (pt) => Math.round(pt * 2);
const hexColor = (c) => String(c || '000000').replace('#', '').toUpperCase().slice(0, 6) || '000000';
const FONT_NAMES = { sans: 'Arial', serif: 'Times New Roman', mono: 'Courier New', cursive: 'Segoe Script' };
const HIGHLIGHTS = { '#FFFF00': 'yellow', '#00FF00': 'green', '#00FFFF': 'cyan', '#FF00FF': 'magenta', '#0000FF': 'blue', '#FF0000': 'red', '#C0C0C0': 'lightGray', '#808080': 'darkGray' };

export async function writeDocx(doc, opts = {}) {
  const zip = new JSZip();
  const media = [];
  const rels = [];
  const numbering = { lists: [] };
  let relId = 1;
  const addImage = (img) => {
    const id = `rId${100 + media.length}`;
    const ext = img.imgType === 'jpg' ? 'jpeg' : 'png';
    const name = `image${media.length + 1}.${ext}`;
    media.push({ name, bytes: img.bytes });
    rels.push(`<Relationship Id="${id}" Type="${R_NS}/image" Target="media/${name}"/>`);
    return id;
  };
  const addLink = (href) => {
    const id = `rId${500 + relId++}`;
    rels.push(`<Relationship Id="${id}" Type="${R_NS}/hyperlink" Target="${escapeXml(href)}" TargetMode="External"/>`);
    return id;
  };
  const numIdFor = (list) => {
    // One numbering instance per (kind, top-level sequence). Lists are restarted when a non-list paragraph intervenes.
    const key = list.kind;
    let entry = numbering.lists.find((l) => l.key === key && l.open);
    if (!entry) { entry = { key, id: numbering.lists.length + 1, kind: list.kind, open: true }; numbering.lists.push(entry); }
    return entry.id;
  };
  const closeLists = () => numbering.lists.forEach((l) => { l.open = false; });

  const runXml = (r, inherit = {}) => {
    if (r.pageBreak) return '<w:r><w:br w:type="page"/></w:r>';
    if (r.br) return '<w:r><w:br/></w:r>';
    if (r.tab) return '<w:r><w:tab/></w:r>';
    if (r.image) return imageXml(r.image);
    const props = [];
    const font = r.fontName || FONT_NAMES[r.family] || FONT_NAMES.sans;
    props.push(`<w:rFonts w:ascii="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:cs="${escapeXml(font)}" w:eastAsia="${escapeXml(font)}"/>`);
    if (r.bold) props.push('<w:b/><w:bCs/>');
    if (r.italic) props.push('<w:i/><w:iCs/>');
    if (r.underline) props.push('<w:u w:val="single"/>');
    if (r.strike) props.push('<w:strike/>');
    if (r.color && hexColor(r.color) !== '000000') props.push(`<w:color w:val="${hexColor(r.color)}"/>`);
    const sz = half(r.size || inherit.size || 11);
    props.push(`<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`);
    if (r.highlight) { const h = HIGHLIGHTS[String(r.highlight).toUpperCase()]; props.push(h ? `<w:highlight w:val="${h}"/>` : `<w:shd w:val="clear" w:color="auto" w:fill="${hexColor(r.highlight)}"/>`); }
    if (r.super) props.push('<w:vertAlign w:val="superscript"/>');
    if (r.sub) props.push('<w:vertAlign w:val="subscript"/>');
    const rPr = `<w:rPr>${props.join('')}</w:rPr>`;
    if (r.field === 'PAGE') return `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>1</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;
    if (r.field === 'NUMPAGES') return `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>1</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;
    const text = String(r.text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const parts = text.split('\t');
    const body = parts.map((p, i) => `${i ? '<w:tab/>' : ''}${p ? `<w:t xml:space="preserve">${escapeXml(p)}</w:t>` : ''}`).join('');
    const xml = `<w:r>${rPr}${body}</w:r>`;
    if (r.link) return `<w:hyperlink r:id="${addLink(r.link)}">${xml}</w:hyperlink>`;
    return xml;
  };
  const imageXml = (img, block = false) => {
    const id = addImage(img);
    const n = media.length;
    const w = emu(img.width || 200), h = emu(img.height || 150);
    const inline = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${w}" cy="${h}"/><wp:docPr id="${n}" name="Picture ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    return block ? `<w:p><w:pPr><w:jc w:val="${img.align || 'left'}"/><w:spacing w:after="120"/></w:pPr>${inline}</w:p>` : inline;
  };
  const paraXml = (b) => {
    const pPr = [];
    if (b.heading != null && b.heading >= 0 && b.heading <= 6) pPr.push(`<w:pStyle w:val="${b.heading === 0 ? 'Title' : 'Heading' + b.heading}"/>`);
    if (b.pageBreakBefore) pPr.push('<w:pageBreakBefore/>');
    if (b.list) { pPr.push(`<w:numPr><w:ilvl w:val="${b.list.level || 0}"/><w:numId w:val="${numIdFor(b.list)}"/></w:numPr>`); } else closeLists();
    const spacing = [];
    if (b.spaceBefore) spacing.push(`w:before="${twips(b.spaceBefore)}"`);
    spacing.push(`w:after="${twips(b.spaceAfter ?? 8)}"`);
    if (b.lineExact) spacing.push(`w:line="${twips(b.lineExact)}" w:lineRule="exact"`);
    else if (b.lineSpacing && b.lineSpacing !== 1) spacing.push(`w:line="${Math.round(b.lineSpacing * 240)}" w:lineRule="auto"`);
    pPr.push(`<w:spacing ${spacing.join(' ')}/>`);
    if (b.indent || b.firstLine || b.hanging || b.indentRight) {
      const ind = [];
      if (b.indent) ind.push(`w:left="${twips(b.indent)}"`);
      if (b.indentRight) ind.push(`w:right="${twips(b.indentRight)}"`);
      if (b.hanging) ind.push(`w:hanging="${twips(b.hanging)}"`); else if (b.firstLine) ind.push(`w:firstLine="${twips(b.firstLine)}"`);
      pPr.push(`<w:ind ${ind.join(' ')}/>`);
    }
    if (b.align && b.align !== 'left') pPr.push(`<w:jc w:val="${b.align === 'justify' ? 'both' : b.align}"/>`);
    if (b.shading) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hexColor(b.shading)}"/>`);
    const runs = (b.runs || []).map((r) => runXml(r, { size: b.size })).join('');
    return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${runs}</w:p>`;
  };
  const tableXml = (t) => {
    const cols = t.colWidths && t.colWidths.length ? t.colWidths : Array.from({ length: Math.max(1, ...t.rows.map((r) => r.cells.reduce((n, c) => n + (c.colSpan || 1), 0))) }, () => 100);
    const totalAvail = doc.pageWidth - doc.margins.left - doc.margins.right;
    const sum = cols.reduce((a, b) => a + b, 0) || 1;
    const scale = sum > totalAvail ? totalAvail / sum : 1;
    const widths = cols.map((c) => twips(c * scale));
    const border = t.borders ? '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders>' : '';
    let xml = `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${border}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    for (const row of t.rows) {
      xml += `<w:tr>${row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
      let col = 0;
      for (const cell of row.cells) {
        const span = cell.colSpan || 1;
        const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0) || widths[0];
        col += span;
        const tcPr = `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${cell.vMerge ? `<w:vMerge${cell.vMerge === 'restart' ? ' w:val="restart"' : ''}/>` : ''}${cell.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${hexColor(cell.shading)}"/>` : ''}</w:tcPr>`;
        const inner = (cell.blocks && cell.blocks.length ? cell.blocks : [{ type: 'paragraph', runs: [] }]).map(blockXml).join('');
        xml += `<w:tc>${tcPr}${/<w:p[ >]/.test(inner) && inner.endsWith('</w:p>') ? inner : inner + '<w:p/>'}</w:tc>`;
      }
      xml += '</w:tr>';
    }
    return xml + '</w:tbl>';
  };
  const blockXml = (b) => {
    switch (b.type) {
      case 'paragraph': return paraXml(b);
      case 'image': return imageXml(b, true);
      case 'table': closeLists(); return tableXml(b);
      case 'pageBreak': closeLists(); return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      case 'hr': closeLists(); return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr><w:spacing w:after="120"/></w:pPr></w:p>';
      case 'absolute': return b.blocks.map(blockXml).join('');
      default: return '';
    }
  };

  const bodyXml = doc.blocks.map(blockXml).join('');
  const headerParts = [];
  const extraParts = [];
  const sectExtra = [];
  for (const [kind, blocks] of [['header', doc.header], ['footer', doc.footer]]) {
    if (!blocks || !blocks.length) continue;
    const id = `rId${900 + (kind === 'header' ? 1 : 2)}`;
    const file = `${kind}1.xml`;
    rels.push(`<Relationship Id="${id}" Type="${R_NS}/${kind}" Target="${file}"/>`);
    const tag = kind === 'header' ? 'hdr' : 'ftr';
    extraParts.push([`word/${file}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} ${NS_DECL}>${blocks.map(blockXml).join('')}</w:${tag}>`]);
    headerParts.push(`<Override PartName="/word/${file}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
    sectExtra.push(`<w:${kind}Reference w:type="default" r:id="${id}"/>`);
  }
  const sectPr = `<w:sectPr>${sectExtra.join('')}<w:pgSz w:w="${twips(doc.pageWidth)}" w:h="${twips(doc.pageHeight)}"${doc.pageWidth > doc.pageHeight ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${twips(doc.margins.top)}" w:right="${twips(doc.margins.right)}" w:bottom="${twips(doc.margins.bottom)}" w:left="${twips(doc.margins.left)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS_DECL}><w:body>${bodyXml}${sectPr}</w:body></w:document>`;

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${headerParts.join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${R_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  zip.file('word/document.xml', document);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R_NS}/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${R_NS}/settings" Target="settings.xml"/>${rels.join('')}</Relationships>`);
  zip.file('word/styles.xml', STYLES_XML);
  zip.file('word/numbering.xml', numberingXml(numbering.lists));
  zip.file('word/settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(doc.title || opts.title || '')}</dc:title><dc:creator>${escapeXml(opts.creator || 'PDF Editor')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PDF Editor</Application></Properties>`);
  for (const m of media) zip.file(`word/media/${m.name}`, m.bytes);
  for (const [path, xml] of extraParts) zip.file(path, xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

const NS_DECL = `xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;

function numberingXml(lists) {
  const abstracts = lists.map((l, i) => {
    const lvls = Array.from({ length: 9 }, (_, lvl) => l.kind === 'bullet'
      ? `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', 'o', '▪'][lvl % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 + lvl * 360}" w:hanging="360"/></w:pPr>${lvl % 3 === 1 ? '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr>' : ''}</w:lvl>`
      : `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][lvl % 3]}"/><w:lvlText w:val="%${lvl + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 + lvl * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
    return `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
  }).join('');
  const nums = lists.map((l, i) => `<w:num w:numId="${l.id}"><w:abstractNumId w:val="${i}"/></w:num>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">${abstracts}${nums}</w:numbering>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Malgun Gothic" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>${[1, 2, 3, 4, 5, 6].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[32, 28, 24, 22, 22, 22][n - 1]}"/></w:rPr></w:style>`).join('')}<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`;
