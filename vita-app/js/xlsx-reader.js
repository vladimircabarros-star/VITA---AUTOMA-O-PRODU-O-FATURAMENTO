// Leitor real do censo (.xlsx): descompacta o arquivo (é um .zip) e lê o XML
// diretamente, sem depender de nenhuma lib de terceiros para interpretar cores
// de preenchimento (a maioria das libs de leitura de xlsx no navegador não expõe
// isso na versão gratuita). Usa JSZip só para descompactar.
//
// Formato observado no censo real do VITA: uma aba por dia, com o título
// "CENSO <MÊS> <ANO> - DD/MM/AAAA" na primeira linha, uma linha de cabeçalho
// (LEITO, NOME, PROCEDIMENTO, IDADE, DN, ADMISSÃO, DIH, CONVÊNIO,
// STATUS PALIAÇÃO, ACOMPANHANTE, OBSERVAÇÃO, CONTATO) e uma linha por leito.
// Eventos do dia (admissão, alta, óbito, transferência, ausência) são marcados
// pela COR DE PREENCHIMENTO da linha (na célula da coluna NOME) — não por uma
// coluna de texto — com uma legenda de cores repetida ao final de cada aba.
(function () {
  "use strict";

  var SS_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  // Cores padrão observadas no arquivo real (ARGB). Servem de fallback caso a
  // legenda não seja encontrada dentro da própria aba.
  var DEFAULT_LEGEND = {
    admissao: 'FF00B0F0',
    alta: 'FF00B050',
    obito: 'FFFF0000',
    transferencia: 'FFFFFF00',
    ausente: 'FFFFC000'
  };

  var HEADER_KEY_MAP = {
    'LEITO': 'leito',
    'NOME': 'nome',
    'PROCEDIMENTO': 'procedimento',
    'IDADE': 'idade',
    'DN': 'dn',
    'ADMISSAO': 'admissao',
    'DIH': 'dih',
    'CONVENIO': 'convenio',
    'STATUS PALIACAO': 'statusPaliacao',
    'ACOMPANHANTE': 'acompanhante',
    'OBSERVACAO': 'observacao',
    'CONTATO': 'contato'
  };

  function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function norm(s) {
    return stripAccents(s).toUpperCase().trim().replace(/\s+/g, ' ');
  }
  function colLetters(ref) {
    var m = /^([A-Z]+)/.exec(ref);
    return m ? m[1] : '';
  }
  function excelSerialToISODate(serial) {
    var n = Number(serial);
    if (!n || isNaN(n)) { return null; }
    var utcDays = Math.floor(n - 25569);
    var ms = utcDays * 86400 * 1000;
    var d = new Date(ms);
    if (isNaN(d.getTime())) { return null; }
    return d.toISOString().slice(0, 10);
  }

  function parseDatesFromText(text) {
    var out = [];
    var re = /(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/g;
    var m;
    while ((m = re.exec(text))) {
      var dd = m[1].padStart(2, '0');
      var mm = m[2].padStart(2, '0');
      var yyyy = m[3].length === 2 ? ('20' + m[3]) : m[3];
      out.push(yyyy + '-' + mm + '-' + dd);
    }
    return out;
  }

  function parseTimesFromText(text) {
    var out = [];
    var re = /(\d{1,2})[:h](\d{2})/gi;
    var m;
    while ((m = re.exec(text))) {
      out.push(m[1].padStart(2, '0') + ':' + m[2]);
    }
    return out;
  }

  function parseKeywordsFromText(text) {
    var t = norm(text);
    var kws = [];
    if (/\bADMITID/.test(t) || /\bADMISSAO\b/.test(t)) { kws.push('admissao'); }
    if (/\bALTA\b/.test(t)) { kws.push('alta'); }
    if (/\bOBITO\b/.test(t)) { kws.push('obito'); }
    if (/\bTRANSFER/.test(t)) { kws.push('transferencia'); }
    if (/\bAUSEN/.test(t)) { kws.push('ausente'); }
    return kws;
  }

  function cellValue(cellEl, sharedStrings) {
    if (!cellEl) { return ''; }
    var t = cellEl.getAttribute('t');
    if (t === 'inlineStr') {
      var isEl = cellEl.getElementsByTagNameNS(SS_NS, 'is')[0];
      if (!isEl) { return ''; }
      var tEl = isEl.getElementsByTagNameNS(SS_NS, 't')[0];
      return tEl ? tEl.textContent : '';
    }
    var vEl = cellEl.getElementsByTagNameNS(SS_NS, 'v')[0];
    if (!vEl) { return ''; }
    var raw = vEl.textContent;
    if (t === 's') {
      var idx = parseInt(raw, 10);
      return sharedStrings[idx] != null ? sharedStrings[idx] : '';
    }
    return raw;
  }

  function buildStyleResolver(stylesDoc) {
    var fillsEls = stylesDoc.getElementsByTagNameNS(SS_NS, 'fills')[0];
    var fills = fillsEls ? Array.prototype.slice.call(fillsEls.getElementsByTagNameNS(SS_NS, 'fill')) : [];
    var cellXfsEls = stylesDoc.getElementsByTagNameNS(SS_NS, 'cellXfs')[0];
    var xfs = cellXfsEls ? Array.prototype.slice.call(cellXfsEls.childNodes).filter(function (n) { return n.nodeType === 1; }) : [];

    function fillArgbForStyleIndex(styleIndex) {
      var idx = styleIndex ? parseInt(styleIndex, 10) : 0;
      var xf = xfs[idx];
      if (!xf) { return null; }
      var fillId = parseInt(xf.getAttribute('fillId') || '0', 10);
      var fill = fills[fillId];
      if (!fill) { return null; }
      var pf = fill.getElementsByTagNameNS(SS_NS, 'patternFill')[0];
      if (!pf) { return null; }
      var fg = pf.getElementsByTagNameNS(SS_NS, 'fgColor')[0];
      if (!fg) { return null; }
      var rgb = fg.getAttribute('rgb');
      return rgb || null; // null = cor de tema (não é uma cor da legenda de eventos)
    }
    return fillArgbForStyleIndex;
  }

  async function readXmlFromZip(zip, path) {
    var entry = zip.file(path);
    if (!entry) { return null; }
    var text = await entry.async('text');
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  function rowCells(rowEl) {
    return Array.prototype.slice.call(rowEl.getElementsByTagNameNS(SS_NS, 'c'));
  }

  async function parseCensoWorkbook(file) {
    var buffer = await file.arrayBuffer();
    var zip = await window.JSZip.loadAsync(buffer);

    var sstDoc = await readXmlFromZip(zip, 'xl/sharedStrings.xml');
    var sharedStrings = [];
    if (sstDoc) {
      var siList = Array.prototype.slice.call(sstDoc.getElementsByTagNameNS(SS_NS, 'si'));
      sharedStrings = siList.map(function (si) {
        var tNodes = Array.prototype.slice.call(si.getElementsByTagNameNS(SS_NS, 't'));
        return tNodes.map(function (t) { return t.textContent; }).join('');
      });
    }

    var stylesDoc = await readXmlFromZip(zip, 'xl/styles.xml');
    var fillFor = stylesDoc ? buildStyleResolver(stylesDoc) : function () { return null; };

    var wbDoc = await readXmlFromZip(zip, 'xl/workbook.xml');
    var relsDoc = await readXmlFromZip(zip, 'xl/_rels/workbook.xml.rels');
    var relTargetById = {};
    if (relsDoc) {
      Array.prototype.slice.call(relsDoc.getElementsByTagName('Relationship')).forEach(function (r) {
        relTargetById[r.getAttribute('Id')] = r.getAttribute('Target');
      });
    }

    var sheetEls = Array.prototype.slice.call(wbDoc.getElementsByTagNameNS(SS_NS, 'sheet'));
    var sheets = [];
    var warnings = [];

    for (var s = 0; s < sheetEls.length; s++) {
      var sheetEl = sheetEls[s];
      var sheetName = sheetEl.getAttribute('name');
      var rId = sheetEl.getAttributeNS(REL_NS, 'id') || sheetEl.getAttribute('r:id');
      var target = relTargetById[rId];
      if (!target) { warnings.push('Aba "' + sheetName + '": relação de arquivo não encontrada.'); continue; }
      var path = 'xl/' + target.replace(/^\/?xl\//, '');
      var sheetDoc = await readXmlFromZip(zip, path);
      if (!sheetDoc) { warnings.push('Aba "' + sheetName + '": arquivo XML não encontrado.'); continue; }

      var rows = Array.prototype.slice.call(sheetDoc.getElementsByTagNameNS(SS_NS, 'row'));

      // --- localizar a linha de título (data da aba) ---
      // Procura em TODAS as células da primeira linha com conteúdo (não só a
      // posição 0) — em xlsx uma linha sem valor na coluna A não grava essa
      // célula (formato esparso), então o título pode estar em B1, C1 etc.
      var titleText = '';
      if (rows[0]) {
        titleText = rowCells(rows[0]).map(function (c) { return cellValue(c, sharedStrings); }).join(' ');
      }
      var titleDates = parseDatesFromText(titleText);
      var sheetDate = titleDates[0] || null;

      // --- localizar a linha de cabeçalho (procura célula "LEITO" em qualquer coluna) ---
      var headerRowIndex = -1, headerMap = {};
      for (var hr = 0; hr < rows.length; hr++) {
        var cells = rowCells(rows[hr]);
        var temLeito = cells.some(function (c) { return norm(cellValue(c, sharedStrings)) === 'LEITO'; });
        if (temLeito) {
          headerRowIndex = hr;
          cells.forEach(function (c) {
            var key = HEADER_KEY_MAP[norm(cellValue(c, sharedStrings))];
            if (key) { headerMap[colLetters(c.getAttribute('r'))] = key; }
          });
          break;
        }
      }
      if (headerRowIndex === -1) {
        warnings.push('Aba "' + sheetName + '": linha de cabeçalho (LEITO/NOME/...) não encontrada — aba ignorada.');
        continue;
      }

      // --- ler linhas de dados até achar "LEGENDA" ---
      var dataRows = [];
      var legend = Object.assign({}, DEFAULT_LEGEND);
      var legendColByLabel = {};
      var inLegend = false;

      for (var i = headerRowIndex + 1; i < rows.length; i++) {
        var rowCellsList = rowCells(rows[i]);
        if (!rowCellsList.length) { continue; }
        var byCol = {};
        rowCellsList.forEach(function (c) { byCol[colLetters(c.getAttribute('r'))] = c; });

        var colA = byCol['A'] ? norm(cellValue(byCol['A'], sharedStrings)) : '';
        if (colA === 'LEGENDA') { inLegend = true; }

        if (inLegend) {
          // Linhas da legenda: rótulo na coluna B, cor na própria célula B.
          var colB = byCol['B'];
          if (colB) {
            var label = norm(cellValue(colB, sharedStrings)).replace(/:$/, '');
            var argb = fillFor(colB.getAttribute('s'));
            var key = label === 'OBITO' ? 'obito'
              : label === 'ALTA' ? 'alta'
              : label === 'ADMISSAO' ? 'admissao'
              : label === 'TRANSFERENCIA' ? 'transferencia'
              : label === 'AUSENTES' ? 'ausente'
              : null;
            if (key && argb) { legendColByLabel[key] = argb; }
          }
          continue;
        }

        var nomeCol = Object.keys(headerMap).filter(function (k) { return headerMap[k] === 'nome'; })[0];
        var nomeCell = nomeCol ? byCol[nomeCol] : null;
        var nome = nomeCell ? cellValue(nomeCell, sharedStrings).trim() : '';
        if (!nome) { continue; } // leito vazio

        var record = { _sheet: sheetName, _sheetDate: sheetDate };
        Object.keys(headerMap).forEach(function (col) {
          var key = headerMap[col];
          var cell = byCol[col];
          var raw = cell ? cellValue(cell, sharedStrings) : '';
          if (key === 'idade' || key === 'dih') {
            record[key] = raw !== '' ? parseInt(raw, 10) : null;
          } else if (key === 'dn' || key === 'admissao') {
            record[key] = raw !== '' ? excelSerialToISODate(raw) : null;
          } else {
            record[key] = typeof raw === 'string' ? raw.trim() : raw;
          }
        });

        var eventArgb = fillFor(nomeCell.getAttribute('s'));
        record.eventColor = eventArgb;
        record.eventType = 'normal';
        if (eventArgb) {
          Object.keys(legend).forEach(function (evt) {
            if (eventArgb === legend[evt]) { record.eventType = evt; }
          });
        }
        record.observacaoKeywords = parseKeywordsFromText(record.observacao || '');
        record.observacaoDatas = parseDatesFromText(record.observacao || '');
        record.observacaoHoras = parseTimesFromText(record.observacao || '');

        dataRows.push(record);
      }

      // Se a legenda da própria aba foi lida com sucesso, ela prevalece sobre o
      // padrão — e então reclassifica os eventos já lidos com a legenda correta.
      if (Object.keys(legendColByLabel).length >= 3) {
        dataRows.forEach(function (r) {
          if (!r.eventColor) { return; }
          r.eventType = 'normal';
          Object.keys(legendColByLabel).forEach(function (evt) {
            if (r.eventColor === legendColByLabel[evt]) { r.eventType = evt; }
          });
        });
        legend = legendColByLabel;
      }

      sheets.push({ name: sheetName, date: sheetDate, titleRaw: titleText, rows: dataRows, legend: legend });
      if (!sheetDate) { warnings.push('Aba "' + sheetName + '": não foi possível identificar a data no título da planilha.'); }
    }

    var datesFound = sheets.map(function (s) { return s.date; }).filter(Boolean).sort();
    var missingDates = [];
    if (datesFound.length > 1) {
      var d = new Date(datesFound[0] + 'T00:00:00Z');
      var last = new Date(datesFound[datesFound.length - 1] + 'T00:00:00Z');
      var have = {};
      datesFound.forEach(function (dt) { have[dt] = true; });
      while (d <= last) {
        var iso = d.toISOString().slice(0, 10);
        if (!have[iso]) { missingDates.push(iso); }
        d.setUTCDate(d.getUTCDate() + 1);
      }
    }

    return {
      sheets: sheets,
      warnings: warnings,
      meta: {
        totalSheets: sheetEls.length,
        sheetsParsed: sheets.length,
        datesFound: datesFound,
        periodoInicio: datesFound[0] || null,
        periodoFim: datesFound[datesFound.length - 1] || null,
        missingDates: missingDates
      }
    };
  }

  window.VitaXlsxReader = {
    parseCensoWorkbook: parseCensoWorkbook,
    parseDatesFromText: parseDatesFromText,
    parseTimesFromText: parseTimesFromText,
    parseKeywordsFromText: parseKeywordsFromText,
    excelSerialToISODate: excelSerialToISODate,
    norm: norm
  };
})();
