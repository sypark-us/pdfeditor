// Document model -> HTML / plain text, and page images -> PPTX.
import { escapeHtml, escapeXml, bytesToBase64 } from './util.js';
import { docText } from './docmodel.js';

export function writeText(doc) { return docText(doc); }

export function writeHtml(doc, opts = {}) {
  const css = `body{font-family:Arial,Helvetica,'Malgun Gothic',sans-serif;max-width:${Math.round(doc.pageWidth - doc.margins.left - doc.margins.right)}pt;margin:24pt auto;padding:0 16px;line-height:1.35;color:#111}p{margin:0 0 8pt}table{border-collapse:collapse;margin:0 0 8pt}td,th{border:1px solid #999;padding:3pt 5pt;vertical-align:top}img{max-width:100%}.page-break{page-break-after:always;border-top:1px dashed #ccc;margin:16pt 0}hr{border:0;border-top:1px solid #999}`;
  const runHtml = (r) => {
    if (r.br) return '<br>';
    if (r.tab) return '&emsp;';
    if (r.pageBreak) return '';
    if (r.image) return `<img src="data:image/${r.image.imgType === 'jpg' ? 'jpeg' : 'png'};base64,${bytesToBase64(r.image.bytes)}" width="${Math.round(r.image.width / 0.75)}" height="${Math.round(r.image.height / 0.75)}">`;
    if (r.field) return r.field === 'PAGE' ? '1' : '1';
    const st = [];
    if (r.bold) st.push('font-weight:bold');
    if (r.italic) st.push('font-style:italic');
    const deco = [r.underline && 'underline', r.strike && 'line-through'].filter(Boolean).join(' ');
    if (deco) st.push(`text-decoration:${deco}`);
    if (r.size && r.size !== 11) st.push(`font-size:${r.size}pt`);
    if (r.color && r.color.toLowerCase() !== '#000000') st.push(`color:${r.color}`);
    if (r.family === 'mono') st.push("font-family:'Courier New',monospace"); else if (r.family === 'serif') st.push("font-family:'Times New Roman',serif");
    if (r.highlight) st.push(`background:${r.highlight}`);
    if (r.super) st.push('vertical-align:super'); if (r.sub) st.push('vertical-align:sub');
    const text = escapeHtml(r.text ?? '').replace(/\t/g, '&emsp;');
    const inner = st.length ? `<span style="${st.join(';')}">${text}</span>` : text;
    return r.link ? `<a href="${escapeHtml(r.link)}">${inner}</a>` : inner;
  };
  const blockHtml = (b) => {
    switch (b.type) {
      case 'paragraph': {
        const st = [];
        if (b.align && b.align !== 'left') st.push(`text-align:${b.align}`);
        if (b.indent) st.push(`margin-left:${b.indent}pt`);
        if (b.firstLine) st.push(`text-indent:${b.firstLine}pt`);
        if (b.spaceBefore) st.push(`margin-top:${b.spaceBefore}pt`);
        if (b.spaceAfter != null) st.push(`margin-bottom:${b.spaceAfter}pt`);
        if (b.shading) st.push(`background:${b.shading};padding:4pt`);
        const tag = b.heading != null && b.heading >= 1 && b.heading <= 6 ? `h${b.heading}` : 'p';
        const marker = b.list ? `<span style="display:inline-block;width:${b.hanging || 18}pt;margin-left:-${b.hanging || 18}pt">${escapeHtml(b.list.text)}</span>` : '';
        return `<${tag}${st.length ? ` style="${st.join(';')}"` : ''}>${marker}${b.runs.map(runHtml).join('')}</${tag}>`;
      }
      case 'image': return `<p${b.align && b.align !== 'left' ? ` style="text-align:${b.align}"` : ''}><img src="data:image/${b.imgType === 'jpg' ? 'jpeg' : 'png'};base64,${bytesToBase64(b.bytes)}" width="${Math.round(b.width / 0.75)}" height="${Math.round(b.height / 0.75)}"></p>`;
      case 'table': return `<table${b.borders === false ? ' style="border:0"' : ''}>${b.rows.map((r) => `<tr>${r.cells.map((c) => `<${r.header ? 'th' : 'td'}${c.colSpan > 1 ? ` colspan="${c.colSpan}"` : ''}${c.shading ? ` style="background:${c.shading}"` : ''}>${(c.blocks || []).map(blockHtml).join('')}</${r.header ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</table>`;
      case 'pageBreak': return '<div class="page-break"></div>';
      case 'hr': return '<hr>';
      case 'absolute': return `<div style="margin:8pt 0">${b.blocks.map(blockHtml).join('')}</div>`;
      default: return '';
    }
  };
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(doc.title || opts.title || 'Document')}</title><style>${css}</style></head><body>\n${doc.blocks.map(blockHtml).join('\n')}\n</body></html>`;
}

/** images: [{ bytes, imgType:'png'|'jpg', width, height }] (points) -> .pptx bytes (one picture per slide). */
export async function writePptx(images, opts = {}) {
  const zip = new JSZip();
  const W = Math.round((opts.slideWidth || (images[0] ? images[0].width : 960)) * 12700);
  const H = Math.round((opts.slideHeight || (images[0] ? images[0].height : 540)) * 12700);
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const n = images.length;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${images.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${R}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(opts.title || 'Presentation')}</dc:title><dc:creator>PDF Editor</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PDF Editor</Application><Slides>${n}</Slides></Properties>`);
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${images.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${images.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 2}" Type="${R}/theme" Target="theme/theme1.xml"/></Relationships>`);
  const spTreeHead = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${P_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${spTreeHead}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="../theme/theme1.xml"/></Relationships>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${P_NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${spTreeHead}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  zip.file('ppt/theme/theme1.xml', THEME_XML);
  images.forEach((img, i) => {
    const ext = img.imgType === 'jpg' ? 'jpeg' : 'png';
    zip.file(`ppt/media/image${i + 1}.${ext}`, img.bytes);
    const cx = Math.round(img.width * 12700), cy = Math.round(img.height * 12700);
    const scale = Math.min(W / cx, H / cy, 1);
    const w = Math.round(cx * scale), h = Math.round(cy * scale), x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P_NS}><p:cSld><p:spTree>${spTreeHead}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${i + 1}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${R}/image" Target="../media/image${i + 1}.${ext}"/></Relationships>`);
  });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
