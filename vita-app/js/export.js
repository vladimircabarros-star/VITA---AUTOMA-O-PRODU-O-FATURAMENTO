// Geração real dos relatórios (Excel via SheetJS, PDF via jsPDF) e upload para
// o bucket "relatorios" do Supabase.
(function () {
  "use strict";

  function confLabel(c) {
    return c === 'alta' ? 'ALTA CONFIANÇA' : c === 'revisao' ? 'REVISÃO RECOMENDADA' : 'BLOQUEADO';
  }
  function brl(v) {
    return v == null ? '' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function gerarExcelFaturamento(contexto) {
    var wb = window.XLSX.utils.book_new();

    var resumo = [
      ['VITA — Relatório de Faturamento'],
      ['Convênio', contexto.convenioNome],
      ['Competência', contexto.competencia],
      ['Período', contexto.periodoLabel],
      [],
      ['Pacientes', contexto.totals.pacientes],
      ['Diárias faturáveis', contexto.totals.diariasFaturaveis],
      ['Valor total', contexto.totals.valorTotal]
    ];
    var wsResumo = window.XLSX.utils.aoa_to_sheet(resumo);
    window.XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');

    var linhas = [['Paciente', 'Diárias faturáveis', 'Valor']];
    contexto.pacientes.forEach(function (p) {
      linhas.push([p.nome_paciente || p.nome, p.diarias_faturaveis != null ? p.diarias_faturaveis : p.diariasFaturaveis, p.valor]);
    });
    var wsPac = window.XLSX.utils.aoa_to_sheet(linhas);
    window.XLSX.utils.book_append_sheet(wb, wsPac, 'Por paciente');

    var out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function gerarPdfFaturamento(contexto) {
    var doc = new window.jspdf.jsPDF();
    doc.setFontSize(14);
    doc.text('VITA — Relatório de Faturamento', 14, 18);
    doc.setFontSize(10);
    doc.text(contexto.convenioNome + ' · Competência ' + contexto.competencia + ' · ' + contexto.periodoLabel, 14, 25);
    doc.text('Pacientes: ' + contexto.totals.pacientes + '   Diárias faturáveis: ' + contexto.totals.diariasFaturaveis + '   Valor total: ' + brl(contexto.totals.valorTotal), 14, 32);

    doc.autoTable({
      startY: 40,
      head: [['Paciente', 'Diárias faturáveis', 'Valor']],
      body: contexto.pacientes.map(function (p) {
        return [p.nome_paciente || p.nome, String(p.diarias_faturaveis != null ? p.diarias_faturaveis : p.diariasFaturaveis), brl(p.valor)];
      })
    });
    return doc.output('blob');
  }

  function gerarExcelPendencias(contexto) {
    var wb = window.XLSX.utils.book_new();
    var linhas = [['Paciente', 'Data(s)', 'Severidade', 'Motivo', 'Ação', 'Justificativa', 'Resolvido em']];
    contexto.pendencias.forEach(function (p) {
      linhas.push([
        p.pacienteNome, p.data_referencia, p.severidade, p.motivo,
        p.acao === 'faturar' ? 'Faturar diária' : p.acao === 'nao_faturar' ? 'Não faturar diária' : '(em aberto)',
        p.justificativa || '', p.resolvido_em ? new Date(p.resolvido_em).toLocaleString('pt-BR') : ''
      ]);
    });
    var ws = window.XLSX.utils.aoa_to_sheet(linhas);
    window.XLSX.utils.book_append_sheet(wb, ws, 'Pendências');
    var out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function gerarPdfPendencias(contexto) {
    var doc = new window.jspdf.jsPDF();
    doc.setFontSize(14);
    doc.text('VITA — Relatório de Pendências e Justificativas (Auditoria)', 14, 18);
    doc.setFontSize(9);
    doc.text('Este documento não faz parte do relatório de faturamento.', 14, 25);
    doc.autoTable({
      startY: 32,
      head: [['Paciente', 'Data(s)', 'Sev.', 'Motivo', 'Ação', 'Justificativa']],
      body: contexto.pendencias.map(function (p) {
        return [p.pacienteNome, p.data_referencia, p.severidade, p.motivo,
          p.acao === 'faturar' ? 'Faturar' : p.acao === 'nao_faturar' ? 'Não faturar' : '—', p.justificativa || ''];
      }),
      styles: { fontSize: 8, cellWidth: 'wrap' },
      columnStyles: { 3: { cellWidth: 45 }, 5: { cellWidth: 45 } }
    });
    return doc.output('blob');
  }

  window.VitaExport = {
    gerarExcelFaturamento: gerarExcelFaturamento,
    gerarPdfFaturamento: gerarPdfFaturamento,
    gerarExcelPendencias: gerarExcelPendencias,
    gerarPdfPendencias: gerarPdfPendencias
  };
})();
