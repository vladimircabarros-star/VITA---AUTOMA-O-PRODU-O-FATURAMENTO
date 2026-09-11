// Motor de cálculo do faturamento: recebe o censo já interpretado
// (VitaXlsxReader.parseCensoWorkbook) e as regras de um convênio, e produz o
// faturamento por paciente com a memória de cálculo diária.
//
// Regra-chave observada no arquivo real: o evento (admissão/alta/óbito/
// transferência) aparece destacado por cor na aba do dia SEGUINTE ao evento,
// e a data real do evento vem escrita por extenso na coluna OBSERVAÇÃO
// (ex.: "ALTA EM 31/07/2026 AS 17:30" numa linha da aba do dia 01/08). Por
// isso a data efetiva de cada evento é extraída do texto sempre que possível;
// quando o texto não traz uma data explícita, assume-se o dia anterior ao da
// aba (dateInferred=true) — e o caso cai para REVISÃO RECOMENDADA, nunca é
// tratado como certeza.
(function () {
  "use strict";

  var norm = window.VitaXlsxReader.norm;

  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dateRange(startIso, endIso) {
    var out = []; var cur = startIso;
    while (cur <= endIso) { out.push(cur); cur = addDays(cur, 1); }
    return out;
  }
  function fmtBR(iso) {
    var p = iso.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function valorDiariaEm(convenioValores, dataIso) {
    var v = (convenioValores || []).filter(function (x) {
      return x.vigencia_inicio <= dataIso && (!x.vigencia_fim || x.vigencia_fim >= dataIso);
    })[0];
    return v ? Number(v.valor_diaria) : null;
  }

  function effectiveEventDate(occurrence) {
    // Prioriza a(s) data(s) explícita(s) escrita(s) na OBSERVAÇÃO; se ausente,
    // assume o dia anterior ao da aba (convenção observada no arquivo real).
    if (occurrence.observacaoDatas && occurrence.observacaoDatas.length) {
      return { date: occurrence.observacaoDatas[0], inferred: false };
    }
    return { date: addDays(occurrence._sheetDate, -1), inferred: true };
  }

  function collectOccurrencesForConvenio(workbook, convenioNome) {
    var alvo = norm(convenioNome);
    var porPaciente = {};
    workbook.sheets.forEach(function (sheet) {
      if (!sheet.date) { return; }
      sheet.rows.forEach(function (r) {
        if (norm(r.convenio) !== alvo) { return; }
        var key = norm(r.nome);
        if (!porPaciente[key]) { porPaciente[key] = { nome: r.nome, occurrences: [] }; }
        porPaciente[key].occurrences.push(r);
      });
    });
    Object.keys(porPaciente).forEach(function (k) {
      porPaciente[k].occurrences.sort(function (a, b) { return a._sheetDate < b._sheetDate ? -1 : 1; });
    });
    return porPaciente;
  }

  function processarPaciente(paciente, convenio, periodoInicio, periodoFim) {
    var regras = convenio.regras || {
      alta_conta_ultima_diaria: true, obito_conta_ultima_diaria: true,
      transferencia_conta_ultima_diaria: false, ausencia_conta_ultima_diaria: false,
      ausencia_tolerancia_horas: 24
    };

    var normalDates = {};
    var admissaoInfo = null;
    var terminalEvents = []; // {type, date, inferred, raw}
    var ausenteOcorrencias = [];

    paciente.occurrences.forEach(function (occ) {
      if (occ.eventType === 'normal') {
        normalDates[occ._sheetDate] = occ;
      } else if (occ.eventType === 'admissao') {
        var ed = effectiveEventDate(occ);
        if (!admissaoInfo || ed.date < admissaoInfo.date) { admissaoInfo = { date: ed.date, inferred: ed.inferred, raw: occ }; }
      } else if (occ.eventType === 'alta' || occ.eventType === 'obito' || occ.eventType === 'transferencia') {
        var ed2 = effectiveEventDate(occ);
        terminalEvents.push({ type: occ.eventType, date: ed2.date, inferred: ed2.inferred, raw: occ });
      } else if (occ.eventType === 'ausente') {
        ausenteOcorrencias.push(occ);
      }
    });

    // ---- limites efetivos do período para este paciente ----
    var terminal = null, conflitoTerminal = false;
    if (terminalEvents.length === 1) {
      terminal = terminalEvents[0];
    } else if (terminalEvents.length > 1) {
      var datasUnicas = {};
      terminalEvents.forEach(function (t) { datasUnicas[t.date + '|' + t.type] = t; });
      var distintos = Object.keys(datasUnicas).length;
      if (distintos > 1) { conflitoTerminal = true; }
      terminal = terminalEvents.sort(function (a, b) { return a.date < b.date ? -1 : 1; })[0];
    }

    if (terminal && terminal.date < periodoInicio) {
      return null; // desfecho ocorreu antes do período selecionado: paciente fora deste faturamento
    }

    var effectiveStart = periodoInicio;
    if (admissaoInfo && admissaoInfo.date > periodoInicio) { effectiveStart = admissaoInfo.date; }
    var effectiveEnd = periodoFim;
    if (terminal && terminal.date < periodoFim) { effectiveEnd = terminal.date; }

    if (effectiveStart > effectiveEnd) { return null; }

    // ---- faixas de ausência (início confirmado -> retorno ou fim do período) ----
    var faixasAusencia = ausenteOcorrencias.map(function (occ) {
      var ed = effectiveEventDate(occ);
      var horaMatch = (occ.observacaoHoras || [])[0] || '00:00';
      return { inicioData: ed.date, inicioHora: horaMatch, inferred: ed.inferred, raw: occ };
    });

    var dias = [];
    var pendenciasCandidatas = [];
    var confidence = 'alta';
    var blocoBloqueado = null; // agrega dias bloqueados consecutivos com o mesmo motivo

    function fecharBloco() {
      if (blocoBloqueado) {
        pendenciasCandidatas.push(blocoBloqueado);
        blocoBloqueado = null;
      }
    }
    function abrirOuEstenderBloco(data, motivo, severidade) {
      if (blocoBloqueado && blocoBloqueado.motivo === motivo && addDays(blocoBloqueado.fim, 1) === data) {
        blocoBloqueado.fim = data;
      } else {
        fecharBloco();
        blocoBloqueado = { inicio: data, fim: data, motivo: motivo, severidade: severidade };
      }
    }

    // Empurra o dia já calculado para a lista, com uma última checagem: um dia
    // marcado como faturável mas sem valor de diária vigente cadastrado não
    // pode virar dinheiro sozinho — cai para pendente em vez de faturar "de
    // graça" ou silenciosamente perder o valor do total.
    function finishDia(entry, mantemBlocoAberto) {
      if (entry.faturavel === 'sim' && entry.valor == null) {
        entry.faturavel = 'pendente';
        entry.regra = 'Sem valor de diária vigente cadastrado para ' + fmtBR(entry.data) + ' — revisão manual necessária';
        if (confidence === 'alta') { confidence = 'revisao'; }
      }
      dias.push(entry);
      if (!mantemBlocoAberto) { fecharBloco(); }
    }

    dateRange(effectiveStart, effectiveEnd).forEach(function (data) {
      var valor = valorDiariaEm(convenio.historico, data);
      var entry = { data: data, status: '', faturavel: 'sim', regra: '', valor: valor != null ? valor : null };

      // 1) conflito de eventos terminais em datas diferentes já detectado -> bloqueia o dia do desfecho
      if (terminal && data === terminal.date && conflitoTerminal) {
        entry.status = 'Múltiplos eventos de desfecho registrados';
        entry.faturavel = 'bloqueado';
        entry.regra = 'Conflito: mais de um evento de desfecho (alta/óbito/transferência) para este paciente — requer decisão manual';
        entry.valor = null;
        confidence = 'bloqueado';
        abrirOuEstenderBloco(data, entry.regra, 'alta');
        finishDia(entry, true); return;
      }

      // 2) dia do desfecho
      if (terminal && data === terminal.date) {
        var contaMap = {
          alta: regras.alta_conta_ultima_diaria,
          obito: regras.obito_conta_ultima_diaria,
          transferencia: regras.transferencia_conta_ultima_diaria
        };
        var conta = contaMap[terminal.type];
        var label = { alta: 'Alta', obito: 'Óbito', transferencia: 'Transferência' }[terminal.type];
        entry.status = label + (terminal.inferred ? ' (data estimada — sem data explícita na observação)' : '');
        entry.faturavel = conta ? 'sim' : 'nao';
        entry.regra = label + ' conta última diária (regra do convênio: ' + (conta ? 'sim' : 'não') + ')';
        if (terminal.inferred) {
          entry.faturavel = 'pendente';
          entry.regra = 'Data do evento não encontrada explicitamente na observação — revisão manual necessária';
          if (confidence === 'alta') { confidence = 'revisao'; }
        }
        if (!conta) { entry.valor = null; }
        finishDia(entry, false); return;
      }

      // 3) dia de admissão
      if (admissaoInfo && data === admissaoInfo.date) {
        entry.status = 'Admissão' + (admissaoInfo.inferred ? ' (data estimada)' : '');
        entry.faturavel = 'sim';
        entry.regra = 'Diária de admissão';
        if (admissaoInfo.inferred) {
          entry.faturavel = 'pendente';
          entry.regra = 'Data de admissão não encontrada explicitamente na observação — revisão manual necessária';
          if (confidence === 'alta') { confidence = 'revisao'; }
        }
        finishDia(entry, false); return;
      }

      // 4) ausência: dentro ou fora da tolerância (precisão de hora, não só de dia)
      var faixa = faixasAusencia.filter(function (f) { return data >= f.inicioData; }).sort(function (a, b) { return b.inicioData < a.inicioData ? -1 : 1; })[0];
      if (faixa) {
        // retorno = primeiro sinal de presença (dia normal, nova admissão ou desfecho) após o início da ausência
        var candidatosRetorno = Object.keys(normalDates).filter(function (d) { return d > faixa.inicioData; });
        if (admissaoInfo && admissaoInfo.date > faixa.inicioData) { candidatosRetorno.push(admissaoInfo.date); }
        if (terminal && terminal.date > faixa.inicioData) { candidatosRetorno.push(terminal.date); }
        var retornoData = candidatosRetorno.sort()[0] || null;
        var fimAusencia = retornoData || effectiveEnd;
        var inicioTs = Date.parse(faixa.inicioData + 'T' + faixa.inicioHora + ':00Z');
        var fimDoDiaTs = Date.parse(data + 'T23:59:00Z');
        var horasAusente = (fimDoDiaTs - inicioTs) / 3600000;
        if (data <= fimAusencia) {
          if (horasAusente <= regras.ausencia_tolerancia_horas) {
            entry.status = 'Ausente (dentro da tolerância)';
            entry.faturavel = 'sim';
            entry.regra = 'Ausência dentro da tolerância do convênio (' + regras.ausencia_tolerancia_horas + 'h) — diária mantida (leito reservado)';
            finishDia(entry, false); return;
          } else {
            entry.status = retornoData ? 'Ausente (sem registro)' : 'Ausente (sem registro de retorno)';
            entry.faturavel = 'bloqueado';
            entry.regra = 'Ausência acima da tolerância do convênio (' + regras.ausencia_tolerancia_horas + 'h) sem retorno documentado — requer decisão manual';
            entry.valor = null;
            confidence = 'bloqueado';
            abrirOuEstenderBloco(data, entry.regra, 'media');
            finishDia(entry, true); return;
          }
        }
      }

      // 5) dia normal confirmado pela planilha
      if (normalDates[data]) {
        entry.status = 'Internado(a)';
        entry.faturavel = 'sim';
        entry.regra = 'Diária padrão';
        finishDia(entry, false); return;
      }

      // 6) nenhum sinal para este dia -> falta no censo
      entry.status = 'Sem registro no censo';
      entry.faturavel = 'pendente';
      entry.regra = 'Dia ausente da planilha — revisão manual necessária';
      entry.valor = null;
      if (confidence === 'alta') { confidence = 'revisao'; }
      finishDia(entry, false);
    });
    fecharBloco();

    var diariasFaturaveis = dias.filter(function (d) { return d.faturavel === 'sim'; }).length;
    var diariasPendentes = dias.filter(function (d) { return d.faturavel === 'pendente' || d.faturavel === 'bloqueado'; }).length;
    var valorTotal = dias.reduce(function (acc, d) { return acc + (d.faturavel === 'sim' && d.valor ? d.valor : 0); }, 0);

    return {
      nome: paciente.nome,
      dias: dias,
      diariasFaturaveis: diariasFaturaveis,
      diariasPendentes: diariasPendentes,
      valor: Math.round(valorTotal * 100) / 100,
      confidence: confidence,
      pendenciasCandidatas: pendenciasCandidatas.map(function (p) {
        return {
          dataReferencia: p.inicio === p.fim ? fmtBR(p.inicio) : (fmtBR(p.inicio) + ' – ' + fmtBR(p.fim)),
          motivo: p.motivo,
          severidade: p.severidade
        };
      })
    };
  }

  function processarConvenio(workbook, convenio, periodoInicio, periodoFim) {
    var agrupado = collectOccurrencesForConvenio(workbook, convenio.nome);
    var pacientes = [];
    Object.keys(agrupado).forEach(function (k) {
      var resultado = processarPaciente(agrupado[k], convenio, periodoInicio, periodoFim);
      if (resultado) { pacientes.push(resultado); }
    });
    pacientes.sort(function (a, b) { return a.nome.localeCompare(b.nome); });

    var totals = {
      pacientes: pacientes.length,
      diariasFaturaveis: pacientes.reduce(function (a, p) { return a + p.diariasFaturaveis; }, 0),
      diariasPendentes: pacientes.reduce(function (a, p) { return a + p.diariasPendentes; }, 0),
      valorTotal: Math.round(pacientes.reduce(function (a, p) { return a + p.valor; }, 0) * 100) / 100
    };

    return { pacientes: pacientes, totals: totals };
  }

  window.VitaBillingEngine = {
    processarConvenio: processarConvenio,
    valorDiariaEm: valorDiariaEm,
    fmtBR: fmtBR
  };
})();
