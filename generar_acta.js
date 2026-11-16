/* generar_acta.js — Rellena la plantilla del acta (docxtemplater) y genera el anexo de fotos.
 *
 * Funciona igual en el navegador (PWA: PizZip y docxtemplater cargados como globales)
 * y en Node (pruebas: require). Devuelve el .docx como Uint8Array.
 *
 * Entrada `acta`:
 * {
 *   obra: { titulo, direccion, proyecto, expediente, emplazamiento, propiedad, director_obra,
 *           director_ejecucion, constructora, jefe_obra, copias,
 *           firma_constructor, firma_do, firma_deo },
 *   fecha: "16/11/2026",
 *   asistentes: { propiedad, do, constructora, deo },         // booleanos
 *   estado: ["ESTRUCTURA - FORJADO PLANTA 1", ...],
 *   bloques: [ { nombre: "DIRECCIÓN DE OBRA", intro: "Referentes a…" | "",
 *                items: [ { texto, fotos: [idFoto, ...] } ] } ],  // solo bloques con ítems
 *   pendientes: ["...", ...],
 *   fotos: { [idFoto]: { datos: Uint8Array (JPEG), ancho, alto, pie } }
 * }
 *
 * Reglas del acta (ESPECIFICACION §6):
 *  - Ítems del punto 2 numerados 2.1…2.n de forma CONTINUA entre bloques.
 *  - Un ítem con fotos lleva « (Fotos 3 y 4)». Las fotos se numeran por orden de aparición.
 *  - Cada foto lleva debajo: «Foto N. <pie> → ver 2.x» (o «2.x y 2.y» si apoya a varios puntos).
 *  - Las fotos que no apoyan a ningún punto NO entran en el anexo (el anexo solo apoya al punto 2).
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) {
    module.exports = fabrica(require("pizzip"), require("docxtemplater"));
  } else {
    raiz.generarActa = fabrica(raiz.PizZip, raiz.docxtemplater);
  }
})(typeof self !== "undefined" ? self : this, function (PizZip, Docxtemplater) {
  "use strict";

  // Caja de cada foto en el anexo = la del acta original (7,3 × 9,73 cm, vertical 3:4), en EMU
  const CAJA_ANCHO = 2628000;
  const CAJA_ALTO = 3504000;
  const ANCHO_CELDA = 5233; // twips: mitad del ancho útil de A4 con márgenes de 720
  const CB_VACIA = ""; // Wingdings: casilla vacía
  const CB_MARCADA = ""; // Wingdings: casilla marcada

  // Escapar texto para insertarlo en OOXML en bruto
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // «1» / «1 y 2» / «1, 2 y 3»
  const enumerar = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " y " + xs[xs.length - 1]);

  /** Numera ítems y fotos y calcula referencias cruzadas. */
  function numerar(acta) {
    const numFoto = new Map(); // idFoto -> nº en el anexo
    const refsFoto = new Map(); // idFoto -> ["2.1", "2.3"]
    let n = 0;
    const bloques = acta.bloques
      .filter((b) => b.items && b.items.length)
      .map((b) => ({
        nombre: b.nombre,
        intro: b.intro ? [{ intro: b.intro }] : [], // lista vacía => el párrafo desaparece
        items: b.items.map((it) => {
          const num = "2." + ++n;
          const nums = (it.fotos || []).map((id) => {
            if (!numFoto.has(id)) numFoto.set(id, numFoto.size + 1);
            if (!refsFoto.has(id)) refsFoto.set(id, []);
            refsFoto.get(id).push(num);
            return numFoto.get(id);
          });
          const ref = nums.length ? ` (Foto${nums.length > 1 ? "s" : ""} ${enumerar(nums)})` : "";
          return { num, texto: it.texto, ref_fotos: ref };
        }),
      }));
    // Fotos del anexo en orden de numeración
    const fotos = [...numFoto.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id, nro]) => ({ id, nro, ...acta.fotos[id], refs: refsFoto.get(id) }));
    return { bloques, fotos };
  }

  /** Tamaño de la foto encajada en la caja, manteniendo proporción. */
  function encajar(ancho, alto) {
    const k = Math.min(CAJA_ANCHO / ancho, CAJA_ALTO / alto);
    return [Math.round(ancho * k), Math.round(alto * k)];
  }

  /** OOXML de una imagen en línea (los prefijos wp:, r: ya están declarados en document.xml). */
  function xmlImagen(rId, idDoc, cx, cy) {
    const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
    return (
      `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${idDoc}" name="Foto ${idDoc}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}">` +
      `<pic:nvPicPr><pic:cNvPr id="${idDoc}" name="foto-${idDoc}.jpg"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>` +
      `</wp:inline></w:drawing></w:r>`
    );
  }

  /** Celda del anexo: foto centrada + línea fina + pie («Foto N. … → ver 2.x»). */
  function xmlCelda(foto) {
    const rpr = `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="18"/></w:rPr>`;
    const contenido = foto
      ? `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${xmlImagen(foto.rId, 1000 + foto.nro, foto.cx, foto.cy)}</w:p>` +
        `<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="2" w:color="000000"/></w:pBdr>` +
        `<w:spacing w:before="40" w:after="240"/><w:ind w:left="${(ANCHO_CELDA - (foto.cx / 635)) / 2 | 0}" ` +
        `w:right="${(ANCHO_CELDA - (foto.cx / 635)) / 2 | 0}"/><w:jc w:val="both"/>${rpr}</w:pPr>` +
        // rPr en negrita respetando el orden del esquema (rFonts, b, sz)
        `<w:r>${rpr.replace("<w:sz ", "<w:b/><w:sz ")}<w:t xml:space="preserve">Foto ${foto.nro}. </w:t></w:r>` +
        `<w:r>${rpr}<w:t xml:space="preserve">${esc(foto.pie || "")} → ver ${esc(enumerar(foto.refs))}</w:t></w:r></w:p>`
      : `<w:p/>`;
    return `<w:tc><w:tcPr><w:tcW w:w="${ANCHO_CELDA}" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr>${contenido}</w:tc>`;
  }

  /** Tabla de 2 columnas sin bordes con todas las fotos del anexo. */
  function xmlAnexo(fotos) {
    if (!fotos.length) return `<w:p><w:r><w:t>Sin fotografías.</w:t></w:r></w:p>`;
    let filas = "";
    for (let i = 0; i < fotos.length; i += 2) {
      filas += `<w:tr><w:trPr><w:cantSplit/></w:trPr>${xmlCelda(fotos[i])}${xmlCelda(fotos[i + 1])}</w:tr>`;
    }
    return (
      `<w:tbl><w:tblPr><w:tblW w:w="${ANCHO_CELDA * 2}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
      `<w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid><w:gridCol w:w="${ANCHO_CELDA}"/>` +
      `<w:gridCol w:w="${ANCHO_CELDA}"/></w:tblGrid>${filas}</w:tbl><w:p/>`
    );
  }

  /** Mete las fotos en el paquete (word/media + relaciones + tipo jpeg) y les asigna rId. */
  function incrustarFotos(zip, fotos) {
    const RELS = "word/_rels/document.xml.rels";
    let rels = zip.file(RELS).asText();
    fotos.forEach((f) => {
      f.rId = "rIdFoto" + f.nro;
      zip.file(`word/media/foto-${f.nro}.jpg`, f.datos);
      rels = rels.replace(
        "</Relationships>",
        `<Relationship Id="${f.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
          `Target="media/foto-${f.nro}.jpg"/></Relationships>`
      );
      [f.cx, f.cy] = encajar(f.ancho, f.alto);
    });
    zip.file(RELS, rels);
    const CT = "[Content_Types].xml";
    let ct = zip.file(CT).asText();
    if (!/Extension="jpg"/i.test(ct)) {
      ct = ct.replace(/(<Types[^>]*>)/,`$1<Default Extension="jpg" ContentType="image/jpeg"/>`);
      zip.file(CT, ct);
    }
  }

  /** Genera el .docx del acta a partir de la plantilla (ArrayBuffer/Uint8Array/Buffer). */
  function generarActa(plantilla, acta) {
    const zip = new PizZip(plantilla);
    const { bloques, fotos } = numerar(acta);
    incrustarFotos(zip, fotos);

    const o = acta.obra;
    const cb = (v) => (v ? CB_MARCADA : CB_VACIA);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => "" });
    doc.render({
      obra_titulo: o.titulo, obra_direccion: o.direccion,
      proyecto: o.proyecto, expediente: o.expediente, emplazamiento: o.emplazamiento,
      fecha: acta.fecha, propiedad: o.propiedad, director_obra: o.director_obra,
      director_ejecucion: o.director_ejecucion, constructor: o.constructora, jefe_obra: o.jefe_obra,
      copias: o.copias || "1",
      cb_propiedad: cb(acta.asistentes.propiedad), cb_do: cb(acta.asistentes.do),
      cb_constructor: cb(acta.asistentes.constructora), cb_deo: cb(acta.asistentes.deo),
      estado: acta.estado.map((texto) => ({ texto })),
      bloques,
      pendientes: acta.pendientes.map((texto) => ({ texto })),
      anexo_fotos: xmlAnexo(fotos),
      firma_constructor: o.firma_constructor || o.constructora,
      firma_do: o.firma_do || o.director_obra,
      firma_deo: o.firma_deo || o.director_ejecucion,
    });
    return doc.getZip().generate({ type: "uint8array", compression: "DEFLATE" });
  }

  generarActa.numerar = numerar; // expuesto para la pantalla de revisión (previsualizar 2.x)
  return generarActa;
});
