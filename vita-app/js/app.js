// VITA — Automação de Produção/Faturamento — app real (sem simulação).
// Toda gravação de dados passa pelo Supabase (js/supabase-client.js); a
// leitura/interpretação do censo é feita pelo navegador (js/xlsx-reader.js e
// js/billing-engine.js) e só o resultado calculado é persistido.
(function () {
  "use strict";

  var DB = window.VitaDB;
  var Reader = window.VitaXlsxReader;
  var Engine = window.VitaBillingEngine;
  var Export = window.VitaExport;

  var PERIODICIDADE_LABEL = {
    mensal_calendario: 'Mensal (calendário)',
    mensal_21_20: 'Mensal (21 a 20)',
    semanal: 'Semanal'
  };

  var state = {
    session: null, profile: null,
    view: 'login',
    authView: 'login', // 'login' | 'signup'
    loginEmail: '', loginPassword: '', loginError: null, loginLoading: false,
    signupNome: '', signupEmail: '', signupPassword: '', signupPasswordConfirm: '',
    signupError: null, signupLoading: false, signupSuccessMsg: null,
    globalError: null,

    convenios: [],
    expandedConvenioId: null,
    novoConvenioAberto: false, novoNome: '', novoPeriodicidade: 'mensal_calendario', novoValor: '', novoDesde: '',
    novaVigenciaAberta: null, novaVigenciaValor: '', novaVigenciaDesde: '',
    convenioBusy: false,

    censoFile: null, censoParse: null, censoParsing: false, censoError: null,

    convenioSel: '', periodoInicio: '', periodoFim: '',
    processando: false, processView: null, processamentoAtualId: null, reopenMode: false,
    expandedPatientIds: {},

    pendencias: [], pendenciasLoading: false, pendenciaDrafts: {}, pendenciaBusy: {},

    historico: [], historicoLoading: false,

    exportMsg: null, exportBusy: false
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtBR(iso) { return Engine.fmtBR(iso); }
  function brl(v) { return v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function firstOrSelf(x) { return Array.isArray(x) ? x[0] : x; }

  function icon(name, extraAttrs) {
    var attrs = extraAttrs || '';
    var paths = {
      home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
      upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/>',
      alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.5 18a1.8 1.8 0 001.6 2.7h15.8a1.8 1.8 0 001.6-2.7L13.7 3.9a1.8 1.8 0 00-3.4 0z"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09a1.7 1.7 0 001.55-1 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H9a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87V9a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.55 1z"/>',
      logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
      check: '<path d="M9 15l-4-4M9 15l10-10"/>',
      doc: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>',
      download: '<path d="M12 15V3M7 10l5 5 5-5"/><path d="M4 17v3a2 2 0 002 2h12a2 2 0 002-2v-3"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>'
    };
    return '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' + attrs + '>' + (paths[name] || '') + '</svg>';
  }
  function spinner(dark) { return '<span class="spinner' + (dark ? ' dark' : '') + '"></span>'; }

  var App = {};
  window.App = App;

  function render() {
    document.getElementById('root').innerHTML = state.session ? renderApp() : renderLogin();
  }
  function preserve(fn) {
    var active = document.activeElement;
    var field = active && active.getAttribute ? active.getAttribute('data-field') : null;
    // input[type=email|number|date|...] não suporta a API de seleção (lança
    // exceção ou retorna null) — nesses casos não há posição de cursor pra
    // restaurar, então nem tentamos (evita quebrar a digitação inteira).
    var selStart = null, selEnd = null;
    try { if (active) { selStart = active.selectionStart; selEnd = active.selectionEnd; } } catch (e) {}
    fn();
    if (field) {
      var el = document.querySelector('[data-field="' + field + '"]');
      if (el) { el.focus(); if (selStart != null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selEnd); } catch (e) {} } }
    }
  }
  async function guarded(onErr, fn) {
    try { await fn(); } catch (e) {
      console.error(e);
      state.globalError = (e && e.message) ? e.message : String(e);
    }
  }

  // ================= AUTH =================

  App.setLoginEmail = function (v) { preserve(function () { state.loginEmail = v; render(); }); };
  App.setLoginPassword = function (v) { preserve(function () { state.loginPassword = v; render(); }); };

  App.entrar = async function () {
    if (!state.loginEmail.trim() || !state.loginPassword.trim()) { return; }
    state.loginLoading = true; state.loginError = null; render();
    try {
      var result = await DB.signIn(state.loginEmail.trim(), state.loginPassword);
      state.session = result.session;
      await afterLogin();
    } catch (e) {
      state.loginError = e && e.message ? traduzErroAuth(e.message) : 'Não foi possível entrar.';
    }
    state.loginLoading = false; render();
  };

  function traduzErroAuth(msg) {
    if (/invalid login credentials/i.test(msg)) { return 'Usuário ou senha incorretos.'; }
    if (/user already registered/i.test(msg)) { return 'Já existe uma conta com este e-mail.'; }
    if (/password should be at least/i.test(msg)) { return 'A senha precisa ter pelo menos 6 caracteres.'; }
    if (/unable to validate email/i.test(msg) || /invalid email/i.test(msg)) { return 'E-mail inválido.'; }
    if (/signups not allowed/i.test(msg) || /signup is disabled/i.test(msg)) { return 'O cadastro de novos usuários está desativado neste projeto (Authentication → Providers no painel do Supabase).'; }
    if (/fetch/i.test(msg) || /network/i.test(msg)) { return 'Não foi possível conectar ao Supabase. Verifique config.js.'; }
    return msg;
  }

  App.goToSignup = function () { state.authView = 'signup'; state.signupError = null; state.signupSuccessMsg = null; render(); };
  App.goToLoginView = function () { state.authView = 'login'; state.loginError = null; render(); };
  App.setSignupField = function (field, v) { preserve(function () { state[field] = v; render(); }); };

  App.cadastrar = async function () {
    var nome = state.signupNome.trim(), email = state.signupEmail.trim();
    if (!nome || !email || !state.signupPassword) { return; }
    if (state.signupPassword.length < 6) { state.signupError = 'A senha precisa ter pelo menos 6 caracteres.'; render(); return; }
    if (state.signupPassword !== state.signupPasswordConfirm) { state.signupError = 'As senhas não coincidem.'; render(); return; }

    state.signupLoading = true; state.signupError = null; render();
    try {
      var result = await DB.signUp(email, state.signupPassword, { nome: nome, cargo: 'Financeiro' });
      if (result.session) {
        state.session = result.session;
        await afterLogin();
      } else {
        state.signupSuccessMsg = 'Conta criada. Verifique seu e-mail (' + email + ') para confirmar o cadastro antes de entrar.';
        state.authView = 'login';
        state.loginEmail = email;
        state.signupNome = ''; state.signupEmail = ''; state.signupPassword = ''; state.signupPasswordConfirm = '';
      }
    } catch (e) {
      state.signupError = e && e.message ? traduzErroAuth(e.message) : 'Não foi possível criar a conta.';
    }
    state.signupLoading = false; render();
  };

  App.sair = async function () {
    await guarded(null, async function () { await DB.signOut(); });
    state.session = null; state.profile = null; state.view = 'login';
    state.loginEmail = ''; state.loginPassword = ''; state.authView = 'login';
    render();
  };

  async function afterLogin() {
    await guarded(null, async function () {
      try { state.profile = await DB.getMyProfile(state.session.user.id); }
      catch (e) { state.profile = { nome: state.session.user.email, cargo: 'Financeiro' }; }
      await Promise.all([reloadConvenios(), reloadPendencias(), reloadHistorico()]);
    });
    state.view = 'dashboard';
  }

  async function reloadConvenios() { state.convenios = await DB.listConvenios(); }
  async function reloadPendencias() { state.pendencias = await DB.listPendencias(); }
  function pendenciasAbertas() { return state.pendencias.filter(function (p) { return p.status === 'aberta'; }); }
  async function reloadHistorico() { state.historico = await DB.listHistorico(); }

  // ================= NAV =================

  App.goTo = function (view) { state.view = view; render(); };
  App.novoProcessamento = function () {
    state.view = 'upload'; state.censoFile = null; state.censoParse = null; state.censoError = null;
    state.periodoInicio = ''; state.periodoFim = ''; state.processView = null; state.processamentoAtualId = null;
    state.reopenMode = false; state.expandedPatientIds = {};
    render();
  };

  // ================= UPLOAD =================

  App.onFileSelected = async function (fileInputEl) {
    var file = fileInputEl.files && fileInputEl.files[0];
    if (!file) { return; }
    state.censoFile = file; state.censoParse = null; state.censoError = null; state.censoParsing = true; render();
    try {
      var parsed = await Reader.parseCensoWorkbook(file);
      if (!parsed.sheets.length) {
        state.censoError = 'Nenhuma aba com o formato esperado foi encontrada neste arquivo (procuro por uma linha com "LEITO" no cabeçalho de cada aba).';
      } else {
        state.censoParse = parsed;
      }
    } catch (e) {
      console.error(e);
      state.censoError = 'Não foi possível ler este arquivo (.xlsx). Detalhe técnico: ' + (e.message || e);
    }
    state.censoParsing = false; render();
  };
  App.removerUpload = function () { state.censoFile = null; state.censoParse = null; state.censoError = null; render(); };
  App.continuarParaSelecao = function () {
    if (!state.censoParse) { return; }
    if (!state.periodoInicio) { state.periodoInicio = state.censoParse.meta.periodoInicio || ''; }
    if (!state.periodoFim) { state.periodoFim = state.censoParse.meta.periodoFim || ''; }
    if (!state.convenioSel && state.convenios.length) { state.convenioSel = state.convenios[0].id; }
    state.view = 'selecao'; render();
  };

  // ================= SELEÇÃO + PROCESSAMENTO =================

  App.setConvenioSel = function (v) { preserve(function () { state.convenioSel = v; render(); }); };
  App.setPeriodoInicio = function (v) { preserve(function () { state.periodoInicio = v; render(); }); };
  App.setPeriodoFim = function (v) { preserve(function () { state.periodoFim = v; render(); }); };

  function normalizeConvenioForEngine(convenio) {
    return {
      nome: convenio.nome,
      historico: convenio.convenio_valores_vigencia || [],
      regras: firstOrSelf(convenio.convenio_regras_evento) || {}
    };
  }

  function fromEngineResult(result, convenio) {
    return {
      convenioNome: convenio.nome,
      competencia: state.periodoFim.slice(0, 7),
      periodoLabel: fmtBR(state.periodoInicio) + ' – ' + fmtBR(state.periodoFim),
      totals: result.totals,
      pacientes: result.pacientes
    };
  }
  function fromDbResult(loaded) {
    var proc = loaded.processamento;
    return {
      convenioNome: proc.convenios ? proc.convenios.nome : '',
      competencia: proc.competencia,
      periodoLabel: fmtBR(proc.periodo_inicio) + ' – ' + fmtBR(proc.periodo_fim),
      totals: {
        pacientes: proc.total_pacientes, diariasFaturaveis: proc.total_diarias_faturaveis,
        diariasPendentes: proc.total_diarias_pendentes, valorTotal: proc.valor_total_confirmado
      },
      pacientes: loaded.pacientes.map(function (p) {
        return {
          nome: p.nome_paciente, diariasFaturaveis: p.diarias_faturaveis, diariasPendentes: p.diarias_pendentes,
          valor: p.valor, confidence: p.nivel_confianca === 'alta_confianca' ? 'alta' : p.nivel_confianca === 'revisao_recomendada' ? 'revisao' : 'bloqueado',
          dias: p.memoria.map(function (m) { return { data: m.data, status: m.status_dia, faturavel: m.faturavel, regra: m.regra_aplicada, valor: m.valor }; })
        };
      })
    };
  }

  App.processar = async function () {
    var convenio = state.convenios.filter(function (c) { return c.id === state.convenioSel; })[0];
    if (!convenio || !state.periodoInicio || !state.periodoFim) { return; }
    state.view = 'processamento'; state.processando = true; state.processView = null;
    state.processamentoAtualId = null; state.reopenMode = false; state.expandedPatientIds = {};
    render();

    await guarded(null, async function () {
      var engineResult = Engine.processarConvenio(state.censoParse, normalizeConvenioForEngine(convenio), state.periodoInicio, state.periodoFim);
      state.processView = fromEngineResult(engineResult, convenio);

      var storagePath = null, uploadWarning = null;
      try { storagePath = await DB.uploadCenso(state.censoFile); }
      catch (e) {
        console.error('Falha ao subir arquivo de censo para o Storage:', e);
        uploadWarning = 'O arquivo original do censo não pôde ser arquivado no Storage (' + (e.message || e) + '). O restante do processamento foi calculado e salvo normalmente, mas o arquivo bruto não ficará disponível para auditoria futura — vale subir de novo depois.';
      }
      state.processView.uploadWarning = uploadWarning;

      var censoRow = await DB.insertCensoUpload({
        nome_arquivo: state.censoFile.name, storage_path: storagePath || ('local:' + state.censoFile.name),
        tamanho_bytes: state.censoFile.size, abas_detectadas: state.censoParse.meta.sheetsParsed,
        periodo_inicio: state.censoParse.meta.periodoInicio, periodo_fim: state.censoParse.meta.periodoFim,
        dias_faltantes: state.censoParse.meta.missingDates, enviado_por: state.session.user.id
      });

      var proc = await DB.insertProcessamento({
        censo_upload_id: censoRow.id, convenio_id: convenio.id, competencia: state.periodoFim.slice(0, 7),
        periodo_inicio: state.periodoInicio, periodo_fim: state.periodoFim, status: 'em_processamento',
        total_pacientes: engineResult.totals.pacientes, total_diarias_faturaveis: engineResult.totals.diariasFaturaveis,
        total_diarias_pendentes: engineResult.totals.diariasPendentes, valor_total_confirmado: engineResult.totals.valorTotal,
        processado_por: state.session.user.id
      });
      state.processamentoAtualId = proc.id;

      var pacientesRows = engineResult.pacientes.map(function (p) {
        return {
          processamento_id: proc.id, nome_paciente: p.nome, diarias_faturaveis: p.diariasFaturaveis,
          diarias_pendentes: p.diariasPendentes, valor: p.valor,
          nivel_confianca: p.confidence === 'alta' ? 'alta_confianca' : p.confidence === 'revisao' ? 'revisao_recomendada' : 'bloqueado'
        };
      });
      var inseridos = pacientesRows.length ? await DB.insertPacientes(pacientesRows) : [];
      var idPorNome = {};
      inseridos.forEach(function (row) { idPorNome[row.nome_paciente] = row.id; });

      var memoriaRows = [], pendenciaRows = [];
      engineResult.pacientes.forEach(function (p) {
        var pacRow = { id: idPorNome[p.nome] };
        p.dias.forEach(function (d) {
          memoriaRows.push({ processamento_paciente_id: pacRow.id, data: d.data, status_dia: d.status, faturavel: d.faturavel, regra_aplicada: d.regra, valor: d.valor });
        });
        p.pendenciasCandidatas.forEach(function (pc) {
          pendenciaRows.push({ processamento_paciente_id: pacRow.id, data_referencia: pc.dataReferencia, motivo: pc.motivo, severidade: pc.severidade, status: 'aberta' });
        });
      });
      await DB.insertMemoria(memoriaRows);
      await DB.insertPendencias(pendenciaRows);
      await DB.updateProcessamentoStatus(proc.id, pendenciaRows.length > 0 ? 'em_processamento' : 'concluido', {});

      await Promise.all([reloadHistorico(), reloadPendencias()]);
    });

    state.processando = false; render();
  };

  App.togglePatient = function (nome) { preserve(function () { state.expandedPatientIds[nome] = !state.expandedPatientIds[nome]; render(); }); };
  App.goExportacao = function () { state.view = 'exportacao'; state.exportMsg = null; render(); };

  App.reabrirHistorico = async function (id) {
    state.view = 'processamento'; state.processando = true; state.reopenMode = true;
    state.processView = null; state.processamentoAtualId = id; state.expandedPatientIds = {};
    render();
    await guarded(null, async function () {
      var loaded = await DB.getProcessamentoCompleto(id);
      state.processView = fromDbResult(loaded);
    });
    state.processando = false; render();
  };

  // ================= PENDÊNCIAS =================

  function draft(id) {
    if (!state.pendenciaDrafts[id]) { state.pendenciaDrafts[id] = { acao: null, justificativa: '' }; }
    return state.pendenciaDrafts[id];
  }
  App.setPendAction = function (id, acao) { preserve(function () { draft(id).acao = acao; render(); }); };
  App.setPendJust = function (id, v) { preserve(function () { draft(id).justificativa = v; render(); }); };
  App.editPend = async function (id) {
    state.pendenciaBusy[id] = true; render();
    await guarded(null, async function () { await DB.reabrirPendencia(id); await refreshProcessamentoStatusFromPend(id); await reloadPendencias(); });
    delete state.pendenciaDrafts[id];
    state.pendenciaBusy[id] = false; render();
  };
  App.savePend = async function (id) {
    var d = draft(id);
    if (!d.acao || !d.justificativa || !d.justificativa.trim()) { return; }
    state.pendenciaBusy[id] = true; render();
    await guarded(null, async function () {
      await DB.resolverPendencia(id, d.acao, d.justificativa.trim(), state.session.user.id);
      await refreshProcessamentoStatusFromPend(id);
      await reloadPendencias();
    });
    delete state.pendenciaDrafts[id];
    state.pendenciaBusy[id] = false; render();
  };
  async function refreshProcessamentoStatusFromPend(pendenciaId) {
    var row = state.pendencias.filter(function (p) { return p.id === pendenciaId; })[0];
    var processamentoId = row && row.processamento_pacientes ? row.processamento_pacientes.processamento_id : null;
    if (!processamentoId) { return; }
    var counts = await DB.countPendenciasAbertasDoProcessamento(processamentoId);
    var status = counts.abertas > 0 ? 'em_processamento' : (counts.total > 0 ? 'concluido_com_pendencias' : 'concluido');
    await DB.updateProcessamentoStatus(processamentoId, status, {});
    await reloadHistorico();
  }

  // ================= CONVÊNIOS =================

  App.toggleConvenio = function (id) { preserve(function () { state.expandedConvenioId = state.expandedConvenioId === id ? null : id; render(); }); };
  App.abrirNovoConvenio = function () { state.novoConvenioAberto = true; render(); };
  App.cancelarNovoConvenio = function () { state.novoConvenioAberto = false; state.novoNome = ''; state.novoValor = ''; state.novoDesde = ''; render(); };
  App.setNovoField = function (field, v) { preserve(function () { state[field] = v; render(); }); };
  App.salvarNovoConvenio = async function () {
    if (!state.novoNome.trim() || !state.novoValor.trim() || !state.novoDesde) { return; }
    state.convenioBusy = true; render();
    await guarded(null, async function () {
      var valorNum = Number(String(state.novoValor).replace(/\./g, '').replace(',', '.'));
      var convenio = await DB.createConvenio({ nome: state.novoNome.trim(), periodicidade: state.novoPeriodicidade });
      await DB.addValorVigencia(convenio.id, valorNum, state.novoDesde);
      await reloadConvenios();
      state.novoConvenioAberto = false; state.novoNome = ''; state.novoValor = ''; state.novoDesde = '';
    });
    state.convenioBusy = false; render();
  };
  App.removerConvenio = async function (ev, id) {
    if (ev && ev.stopPropagation) { ev.stopPropagation(); }
    state.convenioBusy = true; render();
    await guarded(null, async function () { await DB.deleteConvenio(id); await reloadConvenios(); });
    state.convenioBusy = false; render();
  };
  App.toggleRegraBool = async function (convenioId, field) {
    var c = state.convenios.filter(function (x) { return x.id === convenioId; })[0];
    var regras = firstOrSelf(c.convenio_regras_evento) || {};
    state.convenioBusy = true; render();
    await guarded(null, async function () {
      var patch = {}; patch[field] = !regras[field];
      await DB.updateRegraEvento(convenioId, patch);
      await reloadConvenios();
    });
    state.convenioBusy = false; render();
  };
  App.setTolerancia = async function (convenioId, value) {
    state.convenioBusy = true; render();
    await guarded(null, async function () {
      await DB.updateRegraEvento(convenioId, { ausencia_tolerancia_horas: Number(value) || 0 });
      await reloadConvenios();
    });
    state.convenioBusy = false; render();
  };
  App.abrirNovaVigencia = function (convenioId) { state.novaVigenciaAberta = convenioId; state.novaVigenciaValor = ''; state.novaVigenciaDesde = ''; render(); };
  App.cancelarNovaVigencia = function () { state.novaVigenciaAberta = null; render(); };
  App.setNovaVigenciaField = function (field, v) { preserve(function () { state[field] = v; render(); }); };
  App.salvarNovaVigencia = async function (convenioId) {
    if (!state.novaVigenciaValor.trim() || !state.novaVigenciaDesde) { return; }
    state.convenioBusy = true; render();
    await guarded(null, async function () {
      var valorNum = Number(String(state.novaVigenciaValor).replace(/\./g, '').replace(',', '.'));
      await DB.addValorVigencia(convenioId, valorNum, state.novaVigenciaDesde);
      await reloadConvenios();
      state.novaVigenciaAberta = null;
    });
    state.convenioBusy = false; render();
  };

  // ================= EXPORTAÇÃO =================

  async function buildPendenciasContexto(processamentoId) {
    var loaded = await DB.getProcessamentoCompleto(processamentoId);
    var rows = [];
    loaded.pacientes.forEach(function (p) {
      p.pendencias.forEach(function (pd) { rows.push(Object.assign({ pacienteNome: p.nome_paciente }, pd)); });
    });
    return { pendencias: rows };
  }

  App.exportar = async function (tipo, formato) {
    if (!state.processamentoAtualId || !state.processView) { return; }
    state.exportBusy = true; state.exportMsg = null; render();
    await guarded(null, async function () {
      var contexto = state.processView;
      var blob, filename, mimetype;
      if (tipo === 'faturamento') {
        if (formato === 'excel') { blob = Export.gerarExcelFaturamento(contexto); filename = 'faturamento.xlsx'; mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
        else { blob = Export.gerarPdfFaturamento(contexto); filename = 'faturamento.pdf'; mimetype = 'application/pdf'; }
      } else {
        var pendCtx = await buildPendenciasContexto(state.processamentoAtualId);
        if (formato === 'excel') { blob = Export.gerarExcelPendencias(pendCtx); filename = 'pendencias.xlsx'; mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
        else { blob = Export.gerarPdfPendencias(pendCtx); filename = 'pendencias.pdf'; mimetype = 'application/pdf'; }
      }
      var path = state.processamentoAtualId + '/' + Date.now() + '_' + filename;
      var url = await DB.uploadRelatorio(path, blob, mimetype);
      await DB.insertExportacao({ processamento_id: state.processamentoAtualId, tipo: tipo, formato: formato, storage_path: path, gerado_por: state.session.user.id });
      state.exportMsg = {
        texto: (tipo === 'faturamento' ? 'Relatório de faturamento' : 'Relatório de pendências e justificativas') + ' (' + formato.toUpperCase() + ') gerado com sucesso.',
        url: url
      };
    });
    state.exportBusy = false; render();
  };
  App.fecharExportMsg = function () { state.exportMsg = null; render(); };
  App.fecharErro = function () { state.globalError = null; render(); };

  // ================= RENDER: LOGIN / CADASTRO =================

  function authHeader() {
    return '<div style="display:flex; align-items:center; gap:10px; justify-content:center; margin-bottom:28px;">'
    +   '<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><rect x="1" y="1" width="22" height="22" rx="5" fill="var(--accent)"/><path d="M12 6v12M6 12h12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>'
    +   '<div><div style="font-size:19px; font-weight:700; letter-spacing:0.02em; line-height:1;">VITA</div>'
    +   '<div style="font-size:10.5px; color:var(--text-muted); letter-spacing:0.04em; text-transform:uppercase;">Automação de Produção/Faturamento</div></div>'
    + '</div>';
  }

  function renderLogin() {
    var configWarning = !DB.isConfigured()
      ? '<div class="alert alert-warning" style="margin-bottom:16px;">' + icon('alert') + 'config.js ainda não foi preenchido com os dados do seu projeto Supabase — o login não vai funcionar até isso ser feito.</div>'
      : '';
    var body = state.authView === 'signup' ? renderSignupForm() : renderLoginForm();
    return '<div style="display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px;">'
    + '<div style="width:100%; max-width:392px;">'
    +   authHeader()
    +   configWarning
    +   body
    +   '<div style="text-align:center; margin-top:24px; font-size:11.5px; color:var(--text-muted);">VITA Centro de Cuidados Extensivos · Natal/RN</div>'
    + '</div></div>';
  }

  function renderLoginForm() {
    var disabled = !(state.loginEmail.trim() && state.loginPassword.trim()) || state.loginLoading;
    return '<div class="card" style="padding:32px; box-shadow:var(--shadow-sm);">'
    +     '<div style="font-size:16px; font-weight:700; margin-bottom:4px;">Acessar o sistema</div>'
    +     '<div style="font-size:13px; color:var(--text-secondary); margin-bottom:24px;">Entre com seu e-mail e senha.</div>'
    +     (state.signupSuccessMsg ? '<div class="alert alert-success" style="margin-bottom:16px;">' + icon('check') + esc(state.signupSuccessMsg) + '</div>' : '')
    +     (state.loginError ? '<div class="alert alert-danger" style="margin-bottom:16px;">' + icon('alert') + esc(state.loginError) + '</div>' : '')
    +     '<form onsubmit="App.entrar(); return false;" style="display:flex; flex-direction:column; gap:16px;">'
    +       '<div><label class="label">E-mail</label>'
    +       '<input class="field field-login" data-field="login-email" type="text" inputmode="email" autocomplete="username" placeholder="paulo.soares@vita.org.br" value="' + esc(state.loginEmail) + '" oninput="App.setLoginEmail(this.value)" /></div>'
    +       '<div><label class="label">Senha</label>'
    +       '<input class="field field-login" data-field="login-pass" type="password" autocomplete="current-password" placeholder="••••••••" value="' + esc(state.loginPassword) + '" oninput="App.setLoginPassword(this.value)" /></div>'
    +       '<button type="submit" class="btn btn-primary" style="justify-content:center; margin-top:4px; padding:10px 16px;" ' + (disabled ? 'disabled' : '') + '>' + (state.loginLoading ? spinner() : 'Entrar') + '</button>'
    +     '</form>'
    +     '<div style="text-align:center; margin-top:20px; font-size:12.5px; color:var(--text-secondary);">Não tem uma conta? <a onclick="App.goToSignup()" style="font-weight:600;">Criar conta</a></div>'
    +   '</div>';
  }

  function renderSignupForm() {
    var d = state;
    var disabled = !(d.signupNome.trim() && d.signupEmail.trim() && d.signupPassword && d.signupPasswordConfirm) || d.signupLoading;
    return '<div class="card" style="padding:32px; box-shadow:var(--shadow-sm);">'
    +     '<div style="font-size:16px; font-weight:700; margin-bottom:4px;">Criar conta</div>'
    +     '<div style="font-size:13px; color:var(--text-secondary); margin-bottom:24px;">Preencha seus dados para acessar o sistema.</div>'
    +     (d.signupError ? '<div class="alert alert-danger" style="margin-bottom:16px;">' + icon('alert') + esc(d.signupError) + '</div>' : '')
    +     '<form onsubmit="App.cadastrar(); return false;" style="display:flex; flex-direction:column; gap:16px;">'
    +       '<div><label class="label">Nome completo</label>'
    +       '<input class="field field-login" data-field="signup-nome" type="text" autocomplete="name" placeholder="Seu nome" value="' + esc(d.signupNome) + '" oninput="App.setSignupField(\'signupNome\', this.value)" /></div>'
    +       '<div><label class="label">E-mail</label>'
    +       '<input class="field field-login" data-field="signup-email" type="text" inputmode="email" autocomplete="username" placeholder="voce@vita.org.br" value="' + esc(d.signupEmail) + '" oninput="App.setSignupField(\'signupEmail\', this.value)" /></div>'
    +       '<div><label class="label">Senha</label>'
    +       '<input class="field field-login" data-field="signup-pass" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres" value="' + esc(d.signupPassword) + '" oninput="App.setSignupField(\'signupPassword\', this.value)" /></div>'
    +       '<div><label class="label">Confirmar senha</label>'
    +       '<input class="field field-login" data-field="signup-pass2" type="password" autocomplete="new-password" placeholder="Repita a senha" value="' + esc(d.signupPasswordConfirm) + '" oninput="App.setSignupField(\'signupPasswordConfirm\', this.value)" /></div>'
    +       '<button type="submit" class="btn btn-primary" style="justify-content:center; margin-top:4px; padding:10px 16px;" ' + (disabled ? 'disabled' : '') + '>' + (d.signupLoading ? spinner() : 'Criar conta') + '</button>'
    +     '</form>'
    +     '<div style="text-align:center; margin-top:20px; font-size:12.5px; color:var(--text-secondary);">Já tem uma conta? <a onclick="App.goToLoginView()" style="font-weight:600;">Entrar</a></div>'
    +   '</div>';
  }

  // ================= RENDER: SHELL =================

  function renderApp() {
    var headerMap = {
      dashboard: { title: 'Início', subtitle: 'Visão geral da apuração de faturamento' },
      upload: { title: 'Novo processamento', subtitle: 'Etapa 1 de 3 — Upload de censo' },
      selecao: { title: 'Novo processamento', subtitle: 'Etapa 2 de 3 — Convênio e período' },
      processamento: { title: 'Resultado do processamento', subtitle: 'Etapa 3 de 3 — Faturamento apurado' },
      pendencias: { title: 'Resolução de pendências', subtitle: 'Casos bloqueados que exigem decisão manual' },
      convenios: { title: 'Configuração de convênios', subtitle: 'Valores de diária, periodicidade e regras por evento' },
      historico: { title: 'Histórico de competências', subtitle: 'Processamentos anteriores por convênio e período' },
      exportacao: { title: 'Exportação', subtitle: 'Gerar relatórios de faturamento e de auditoria' }
    };
    var h = headerMap[state.view] || headerMap.dashboard;
    var isFlow = state.view === 'upload' || state.view === 'selecao' || state.view === 'processamento';
    function navCls(cond) { return 'nav-btn' + (cond ? ' active' : ''); }

    var content;
    if (state.view === 'dashboard') { content = renderDashboard(); }
    else if (state.view === 'upload') { content = renderUpload(); }
    else if (state.view === 'selecao') { content = renderSelecao(); }
    else if (state.view === 'processamento') { content = renderProcessamento(); }
    else if (state.view === 'pendencias') { content = renderPendencias(); }
    else if (state.view === 'convenios') { content = renderConvenios(); }
    else if (state.view === 'historico') { content = renderHistorico(); }
    else if (state.view === 'exportacao') { content = renderExportacao(); }
    else { content = renderDashboard(); }

    var errorBanner = state.globalError
      ? '<div class="alert alert-danger" style="margin-bottom:20px;">' + icon('alert') + '<div style="flex:1;">' + esc(state.globalError) + '</div><a onclick="App.fecharErro()" style="font-weight:600;">✕</a></div>'
      : '';

    var profileNome = state.profile ? state.profile.nome : '';
    var iniciais = profileNome.split(' ').filter(Boolean).slice(0, 2).map(function (p) { return p[0]; }).join('').toUpperCase();

    return '<div style="display:flex; min-height:100vh;">'
    +   '<div style="width:252px; flex-shrink:0; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; padding:20px 14px;">'
    +     '<div style="display:flex; align-items:center; gap:9px; padding:6px 8px 22px 8px;">'
    +       '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="1" y="1" width="22" height="22" rx="5" fill="var(--accent)"/><path d="M12 6v12M6 12h12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>'
    +       '<div><div style="font-size:15.5px; font-weight:700; letter-spacing:0.02em; line-height:1;">VITA</div>'
    +       '<div style="font-size:9px; color:var(--text-muted); letter-spacing:0.03em; text-transform:uppercase;">Produção/Faturamento</div></div>'
    +     '</div>'
    +     '<div style="display:flex; flex-direction:column; gap:2px;">'
    +       '<button class="' + navCls(state.view === 'dashboard') + '" onclick="App.goTo(\'dashboard\')">' + icon('home') + 'Início</button>'
    +       '<button class="' + navCls(isFlow) + '" onclick="App.novoProcessamento()">' + icon('upload') + 'Novo processamento</button>'
    +       '<button class="' + navCls(state.view === 'pendencias') + '" onclick="App.goTo(\'pendencias\')">' + icon('alert') + '<span style="flex:1; text-align:left;">Pendências</span>'
    +         (pendenciasAbertas().length > 0 ? '<span style="background:var(--danger); color:#fff; font-size:10.5px; font-weight:700; border-radius:100px; padding:1px 7px;">' + pendenciasAbertas().length + '</span>' : '')
    +       '</button>'
    +       '<button class="' + navCls(state.view === 'historico') + '" onclick="App.goTo(\'historico\')">' + icon('clock') + 'Histórico</button>'
    +       '<button class="' + navCls(state.view === 'convenios') + '" onclick="App.goTo(\'convenios\')">' + icon('gear') + 'Configuração de convênios</button>'
    +     '</div>'
    +     '<div style="margin-top:auto; padding-top:16px; border-top:1px solid var(--border);">'
    +       '<div style="display:flex; align-items:center; gap:9px; padding:8px;">'
    +         '<div style="width:30px; height:30px; border-radius:50%; background:var(--accent-soft); color:var(--accent); display:flex; align-items:center; justify-content:center; font-size:12.5px; font-weight:700; flex-shrink:0;">' + esc(iniciais || '?') + '</div>'
    +         '<div style="min-width:0;"><div style="font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(profileNome) + '</div><div style="font-size:11px; color:var(--text-muted);">' + esc(state.profile ? state.profile.cargo : '') + '</div></div>'
    +         '<button class="btn-ghost" style="padding:6px; margin-left:auto; border-radius:5px;" onclick="App.sair()" title="Sair">' + icon('logout') + '</button>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    +   '<div style="flex:1; display:flex; flex-direction:column; min-width:0;">'
    +     '<div style="height:64px; flex-shrink:0; border-bottom:1px solid var(--border); background:var(--surface); display:flex; align-items:center; padding:0 32px;">'
    +       '<div><div style="font-size:16px; font-weight:700;">' + esc(h.title) + '</div><div style="font-size:12.5px; color:var(--text-muted);">' + esc(h.subtitle) + '</div></div>'
    +     '</div>'
    +     '<div style="flex:1; overflow:auto; padding:32px;">' + errorBanner + content + '</div>'
    +   '</div>'
    + '</div>';
  }

  function historicoRowHtml(row) {
    var statusMeta = { 'concluido': { bg: 'var(--success-bg)', color: 'var(--success)', border: 'var(--success-border)', label: 'Concluído' },
      'concluido_com_pendencias': { bg: 'var(--warning-bg)', color: 'var(--warning)', border: 'var(--warning-border)', label: 'Concluído com pendências' },
      'em_processamento': { bg: 'var(--accent-soft)', color: 'var(--accent)', border: 'var(--accent-soft-strong)', label: 'Em processamento' } };
    var m = statusMeta[row.status] || statusMeta.em_processamento;
    return '<tr><td class="mono">' + esc(row.competencia) + '</td><td style="font-weight:600;">' + esc(row.convenios ? row.convenios.nome : '') + '</td>'
      + '<td class="mono" style="color:var(--text-secondary);">' + fmtBR(row.periodo_inicio) + ' – ' + fmtBR(row.periodo_fim) + '</td>'
      + '<td class="mono" style="color:var(--text-secondary);">' + new Date(row.processado_em).toLocaleDateString('pt-BR') + '</td>'
      + '<td><span class="badge" style="background:' + m.bg + '; color:' + m.color + '; border-color:' + m.border + ';">' + m.label + '</span></td>'
      + '<td style="text-align:right;"><a onclick="App.reabrirHistorico(\'' + row.id + '\')">Reabrir</a></td></tr>';
  }

  // ================= RENDER: DASHBOARD =================

  function renderDashboard() {
    var rows = state.historico.slice(0, 4).map(historicoRowHtml).join('');
    var abertasCount = pendenciasAbertas().length;
    var pendTitle = abertasCount > 0 ? 'Pendências em aberto' : 'Nenhuma pendência em aberto';
    var pendSub = abertasCount > 0 ? (abertasCount + ' caso(s) bloqueado(s) aguardando decisão manual.') : 'Todos os casos bloqueados foram resolvidos.';
    var iconColor = abertasCount > 0 ? 'var(--danger)' : 'var(--success)';
    var ultimo = state.historico[0];
    return '<div style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:16px; margin-bottom:28px;">'
    +   '<div class="card" style="background:var(--accent); border-color:var(--accent); padding:22px; display:flex; flex-direction:column; gap:10px;">'
    +     icon('upload', 'style="color:#fff"')
    +     '<div style="color:#fff; font-size:15px; font-weight:700;">Novo processamento</div>'
    +     '<div style="color:#DCE9F2; font-size:12.5px; line-height:1.5;">Envie o censo do mês e apure o faturamento por convênio.</div>'
    +     '<button class="btn btn-secondary" style="justify-content:center; margin-top:6px;" onclick="App.novoProcessamento()">Iniciar</button>'
    +   '</div>'
    +   '<div class="card" style="padding:22px; display:flex; flex-direction:column; gap:10px;">'
    +     '<span style="color:' + iconColor + '">' + icon('alert') + '</span>'
    +     '<div style="font-size:15px; font-weight:700;">' + pendTitle + '</div>'
    +     '<div style="font-size:12.5px; color:var(--text-secondary); line-height:1.5;">' + pendSub + '</div>'
    +     '<a onclick="App.goTo(\'pendencias\')" style="font-size:12.5px; font-weight:600; margin-top:6px;">Ver pendências →</a>'
    +   '</div>'
    +   '<div class="card" style="padding:22px; display:flex; flex-direction:column; gap:10px;">'
    +     icon('clock')
    +     '<div style="font-size:15px; font-weight:700;">Último processamento</div>'
    +     '<div style="font-size:12.5px; color:var(--text-secondary); line-height:1.5;">' + (ultimo ? esc(ultimo.convenios.nome) + ' · Competência ' + esc(ultimo.competencia) : 'Nenhum processamento ainda.') + '</div>'
    +     (ultimo ? '<a onclick="App.reabrirHistorico(\'' + ultimo.id + '\')" style="font-size:12.5px; font-weight:600; margin-top:6px;">Ver detalhes →</a>' : '')
    +   '</div>'
    + '</div>'
    + '<div class="card">'
    +   '<div style="padding:16px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between;">'
    +     '<div style="font-size:14px; font-weight:700;">Últimos processamentos</div>'
    +     '<a onclick="App.goTo(\'historico\')" style="font-size:12.5px; font-weight:600;">Ver histórico completo →</a>'
    +   '</div>'
    +   (rows ? '<div class="table-wrap"><table><thead><tr><th>Competência</th><th>Convênio</th><th>Período</th><th>Processado em</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div style="padding:32px; text-align:center; color:var(--text-muted); font-size:13px;">Nenhum processamento registrado ainda. Clique em "Novo processamento" para começar.</div>')
    + '</div>';
  }

  // ================= RENDER: UPLOAD =================

  function renderUpload() {
    var body;
    if (state.censoParsing) {
      body = '<div class="card" style="padding:56px 32px; text-align:center;">' + spinner(true) + '<div style="margin-top:12px; font-size:13.5px; color:var(--text-secondary);">Lendo o arquivo — interpretando abas, datas e cores de evento...</div></div>';
    } else if (state.censoError) {
      body = '<div class="alert alert-danger">' + icon('alert') + '<div>' + esc(state.censoError) + '</div></div>'
        + '<div style="margin-top:16px;"><label class="btn btn-secondary" style="cursor:pointer;">Escolher outro arquivo<input type="file" accept=".xlsx" style="display:none;" onchange="App.onFileSelected(this)"/></label></div>';
    } else if (!state.censoParse) {
      body = '<label class="card" style="display:block; border:2px dashed var(--border-strong); border-radius:8px; background:var(--surface); padding:56px 32px; text-align:center; cursor:pointer;">'
        + '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto 14px;"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>'
        + '<div style="font-size:14.5px; font-weight:600; margin-bottom:4px;">Clique para selecionar o arquivo do censo</div>'
        + '<div style="font-size:12.5px; color:var(--text-muted);">Censo bruto contínuo — um único arquivo .xlsx com uma aba por dia</div>'
        + '<input type="file" accept=".xlsx" style="display:none;" onchange="App.onFileSelected(this)"/>'
        + '</label>';
    } else {
      var meta = state.censoParse.meta;
      var missing = meta.missingDates || [];
      var missingHtml = missing.length
        ? '<div class="alert alert-warning" style="margin-top:16px;">' + icon('alert')
          + '<div><strong>Atenção:</strong> não foi encontrada aba para ' + (missing.length === 1 ? 'o dia' : missing.length + ' dias') + ' dentro do período identificado: '
          + missing.slice(0, 8).map(fmtBR).join(', ') + (missing.length > 8 ? ' e mais ' + (missing.length - 8) + '...' : '')
          + '. Pacientes internados nessas datas podem ficar marcados para revisão.</div></div>'
        : '';
      var warningsHtml = state.censoParse.warnings.length
        ? '<div class="alert alert-warning" style="margin-top:12px;">' + icon('alert') + '<div>' + state.censoParse.warnings.map(esc).join('<br/>') + '</div></div>'
        : '';
      body = '<div class="card" style="padding:20px;">'
        + '<div style="display:flex; align-items:center; gap:12px; padding-bottom:16px; border-bottom:1px solid var(--border); margin-bottom:16px;">'
        +   '<div style="width:38px; height:38px; border-radius:5px; background:var(--success-bg); display:flex; align-items:center; justify-content:center; flex-shrink:0;">' + icon('check', 'style="stroke:var(--success)"') + '</div>'
        +   '<div style="flex:1; min-width:0;"><div style="font-size:13.5px; font-weight:600;">' + esc(state.censoFile.name) + '</div><div style="font-size:12px; color:var(--text-muted);">' + (state.censoFile.size / 1024 / 1024).toFixed(1) + ' MB</div></div>'
        +   '<a onclick="App.removerUpload()" style="font-size:12.5px; font-weight:600; color:var(--danger);">Remover</a>'
        + '</div>'
        + '<div style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:16px;">'
        +   '<div><div class="label" style="margin-bottom:2px;">Abas detectadas</div><div style="font-size:20px; font-weight:700;" class="mono">' + meta.sheetsParsed + '</div></div>'
        +   '<div><div class="label" style="margin-bottom:2px;">Dias com dado válido</div><div style="font-size:20px; font-weight:700;" class="mono">' + meta.datesFound.length + '</div></div>'
        +   '<div><div class="label" style="margin-bottom:2px;">Período identificado</div><div style="font-size:14.5px; font-weight:700; margin-top:5px;" class="mono">' + (meta.periodoInicio ? fmtBR(meta.periodoInicio) + ' – ' + fmtBR(meta.periodoFim) : '—') + '</div></div>'
        + '</div>'
        + missingHtml + warningsHtml
        + '</div>';
    }
    return '<div style="max-width:760px;">'
      + '<div style="display:flex; gap:8px; margin-bottom:24px; font-size:12.5px; font-weight:600; color:var(--text-muted);">'
      +   '<span style="color:var(--accent);">① Upload de censo</span><span>—</span><span>② Convênio e período</span><span>—</span><span>③ Processamento</span>'
      + '</div>'
      + body
      + '<div style="display:flex; justify-content:flex-end; margin-top:20px;">'
      +   '<button class="btn btn-primary" ' + (state.censoParse ? '' : 'disabled') + ' onclick="App.continuarParaSelecao()">Continuar →</button>'
      + '</div></div>';
  }

  // ================= RENDER: SELEÇÃO =================

  function renderSelecao() {
    var options = state.convenios.map(function (c) {
      return '<option value="' + esc(c.id) + '" ' + (c.id === state.convenioSel ? 'selected' : '') + '>' + esc(c.nome) + '</option>';
    }).join('');
    var sel = state.convenios.filter(function (c) { return c.id === state.convenioSel; })[0];
    return '<div style="max-width:640px;">'
    + '<div style="display:flex; gap:8px; margin-bottom:24px; font-size:12.5px; font-weight:600; color:var(--text-muted);">'
    +   '<span>① Upload de censo</span><span>—</span><span style="color:var(--accent);">② Convênio e período</span><span>—</span><span>③ Processamento</span>'
    + '</div>'
    + '<div class="card" style="padding:24px;">'
    +   (state.convenios.length === 0
        ? '<div class="alert alert-warning">' + icon('alert') + 'Nenhum convênio cadastrado ainda. Cadastre um em "Configuração de convênios" antes de processar.</div>'
        : '<div style="margin-bottom:20px;"><label class="label">Convênio</label>'
          + '<select class="field" data-field="sel-convenio" onchange="App.setConvenioSel(this.value)">' + options + '</select>'
          + '<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">' + (sel ? 'Periodicidade de fechamento: ' + PERIODICIDADE_LABEL[sel.periodicidade] : '') + '</div></div>')
    +   '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:8px;">'
    +     '<div><label class="label">Data início</label><input class="field" data-field="periodo-inicio" type="date" value="' + esc(state.periodoInicio) + '" onblur="App.setPeriodoInicio(this.value)" /></div>'
    +     '<div><label class="label">Data fim</label><input class="field" data-field="periodo-fim" type="date" value="' + esc(state.periodoFim) + '" onblur="App.setPeriodoFim(this.value)" /></div>'
    +   '</div>'
    +   '<div style="font-size:12px; color:var(--text-muted); margin-bottom:20px;">Sugerido a partir das abas detectadas no arquivo — confirme antes de processar.</div>'
    +   '<div style="display:flex; align-items:center; gap:12px; padding:14px 16px; background:var(--surface-alt); border:1px solid var(--border); border-radius:5px; opacity:0.6;">'
    +     '<button class="switch" disabled style="cursor:not-allowed;"><span class="knob"></span></button>'
    +     '<div style="flex:1;"><div style="font-size:13px; font-weight:600;">Calcular período automaticamente</div>'
    +     '<div style="font-size:11.5px; color:var(--text-muted);">Detecta a janela de fechamento do convênio a partir do censo enviado.</div></div>'
    +     '<span class="badge" style="background:var(--surface); color:var(--text-muted); border-color:var(--border-strong);">Em breve</span>'
    +   '</div>'
    + '</div>'
    + '<div style="display:flex; justify-content:flex-end; margin-top:20px;">'
    +   '<button class="btn btn-primary" ' + (!sel || !state.periodoInicio || !state.periodoFim ? 'disabled' : '') + ' onclick="App.processar()">Processar faturamento →</button>'
    + '</div></div>';
  }

  // ================= RENDER: PROCESSAMENTO =================

  function faturavelMeta(f) {
    if (f === 'sim') { return { color: 'var(--success)', label: 'Sim' }; }
    if (f === 'nao') { return { color: 'var(--text-muted)', label: 'Não' }; }
    if (f === 'pendente') { return { color: 'var(--warning)', label: 'Pendente' }; }
    return { color: 'var(--danger)', label: 'Bloqueado' };
  }
  function confMeta(c) {
    if (c === 'alta') { return { label: 'ALTA CONFIANÇA', bg: 'var(--success-bg)', color: 'var(--success)', border: 'var(--success-border)' }; }
    if (c === 'revisao') { return { label: 'REVISÃO RECOMENDADA', bg: 'var(--warning-bg)', color: 'var(--warning)', border: 'var(--warning-border)' }; }
    return { label: 'BLOQUEADO', bg: 'var(--danger-bg)', color: 'var(--danger)', border: 'var(--danger-border)' };
  }

  function renderProcessamento() {
    if (state.processando) {
      return '<div class="card" style="padding:64px; text-align:center;">' + spinner(true) + '<div style="margin-top:14px; font-size:13.5px; color:var(--text-secondary);">' + (state.reopenMode ? 'Carregando processamento salvo...' : 'Calculando faturamento diária a diária...') + '</div></div>';
    }
    if (!state.processView) {
      return '<div class="alert alert-warning">' + icon('alert') + 'Nenhum resultado para exibir.</div>';
    }
    var v = state.processView;
    var abertas = v.pacientes.reduce(function (acc, p) { return acc + (p.confidence === 'bloqueado' ? 1 : 0); }, 0);

    var patientsHtml = v.pacientes.map(function (p) {
      var meta = confMeta(p.confidence);
      var expanded = !!state.expandedPatientIds[p.nome];
      var row = '<tr class="row-clickable" onclick="App.togglePatient(\'' + esc(p.nome.replace(/'/g, "\\'")) + '\')">'
        + '<td><svg class="icon chevron' + (expanded ? ' open' : '') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></td>'
        + '<td style="font-weight:600;">' + esc(p.nome) + '</td>'
        + '<td class="mono">' + p.diariasFaturaveis + '</td>'
        + '<td class="mono" style="' + (p.diariasPendentes > 0 ? 'color:var(--danger); font-weight:600;' : 'color:var(--text-muted);') + '">' + (p.diariasPendentes || '—') + '</td>'
        + '<td class="mono" style="font-weight:600;">' + brl(p.valor) + '</td>'
        + '<td><span class="badge" style="background:' + meta.bg + '; color:' + meta.color + '; border-color:' + meta.border + ';">' + meta.label + '</span></td>'
        + '</tr>';
      if (expanded) {
        var diasHtml = p.dias.map(function (d) {
          var fm = faturavelMeta(d.faturavel);
          return '<tr><td class="mono">' + fmtBR(d.data) + '</td><td>' + esc(d.status) + '</td>'
            + '<td style="color:' + fm.color + '; font-weight:600;">' + fm.label + '</td>'
            + '<td style="color:var(--text-secondary);">' + esc(d.regra) + '</td>'
            + '<td class="mono">' + (d.valor != null ? brl(d.valor) : '—') + '</td></tr>';
        }).join('');
        row += '<tr><td colspan="6" style="background:var(--surface-alt); padding:0;"><div style="padding:16px 20px 20px 52px;">'
          + '<div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-muted); margin-bottom:10px;">Memória de cálculo diária</div>'
          + '<div class="table-wrap"><table style="background:var(--surface); border:1px solid var(--border); border-radius:5px; overflow:hidden;">'
          + '<thead><tr><th>Data</th><th>Status</th><th>Faturável</th><th>Regra aplicada</th><th>Valor</th></tr></thead><tbody>' + diasHtml + '</tbody></table></div>'
          + '</div></td></tr>';
      }
      return row;
    }).join('');

    return (state.reopenMode ? '<div class="alert alert-info" style="margin-bottom:20px;">' + icon('clock') + 'Visualizando processamento reaberto do histórico (somente leitura).<a onclick="App.goTo(\'historico\')" style="margin-left:auto; font-weight:600;">Voltar ao histórico</a></div>' : '')
    + (v.uploadWarning ? '<div class="alert alert-warning" style="margin-bottom:20px;">' + icon('alert') + '<div>' + esc(v.uploadWarning) + '</div></div>' : '')
    + '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px;">'
    +   '<div style="font-size:13px; color:var(--text-secondary);">' + esc(v.convenioNome) + ' · ' + v.periodoLabel + ' · Competência ' + esc(v.competencia) + '</div>'
    +   '<button class="btn btn-secondary" onclick="App.goExportacao()">' + icon('download') + 'Exportar relatórios</button>'
    + '</div>'
    + '<div style="display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:16px; margin-bottom:24px;">'
    +   '<div class="card" style="padding:18px;"><div class="label">Pacientes</div><div style="font-size:26px; font-weight:700;" class="mono">' + v.totals.pacientes + '</div></div>'
    +   '<div class="card" style="padding:18px;"><div class="label">Diárias faturáveis</div><div style="font-size:26px; font-weight:700;" class="mono">' + v.totals.diariasFaturaveis + '</div></div>'
    +   '<div class="card" style="padding:18px;"><div class="label">Valor total (confirmado)</div><div style="font-size:26px; font-weight:700;" class="mono">' + brl(v.totals.valorTotal) + '</div></div>'
    +   '<div class="card" style="padding:18px; border-color:var(--danger-border); background:var(--danger-bg);"><div class="label" style="color:var(--danger);">Pacientes com bloqueio</div><div style="font-size:26px; font-weight:700; color:var(--danger);" class="mono">' + abertas + '</div></div>'
    + '</div>'
    + '<div class="card">'
    +   '<div style="padding:16px 20px; border-bottom:1px solid var(--border); font-size:14px; font-weight:700;">Faturamento por paciente</div>'
    +   '<div class="table-wrap"><table><thead><tr><th style="width:28px;"></th><th>Paciente</th><th>Diárias faturáveis</th><th>Diárias pendentes</th><th>Valor</th><th>Confiança</th></tr></thead><tbody>' + patientsHtml + '</tbody></table></div>'
    + '</div>'
    + (abertas > 0 ? '<div style="display:flex; justify-content:flex-end; margin-top:20px;"><button class="btn btn-primary" onclick="App.goTo(\'pendencias\')">Resolver pendências →</button></div>' : '');
  }

  // ================= RENDER: PENDÊNCIAS =================

  function renderPendencias() {
    var abertasCount = pendenciasAbertas().length;
    var summary = abertasCount > 0
      ? (abertasCount + ' caso(s) bloqueado(s) precisam de decisão manual antes da exportação do faturamento.')
      : 'Nenhuma pendência em aberto no momento.';
    var cards = state.pendencias.map(function (pd) {
      var ctx = pd.processamento_pacientes;
      var sev = pd.severidade === 'alta' ? { bg: 'var(--danger-bg)', color: 'var(--danger)', border: 'var(--danger-border)' } : { bg: 'var(--warning-bg)', color: 'var(--warning)', border: 'var(--warning-border)' };
      var busy = !!state.pendenciaBusy[pd.id];
      var header = '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px;">'
        +   '<div><div style="font-size:14.5px; font-weight:700;">' + esc(ctx.nome_paciente) + '</div>'
        +   '<div style="font-size:12px; color:var(--text-muted); margin-top:2px;" class="mono">' + esc(pd.data_referencia) + ' · ' + esc(ctx.processamentos.convenios.nome) + ' ' + esc(ctx.processamentos.competencia) + '</div></div>'
        +   '<span class="badge" style="background:' + sev.bg + '; color:' + sev.color + '; border-color:' + sev.border + ';">Severidade ' + (pd.severidade === 'alta' ? 'Alta' : 'Média') + '</span>'
        + '</div>'
        + '<div style="font-size:13px; color:var(--text-secondary); line-height:1.5; margin-bottom:16px;">' + esc(pd.motivo) + '</div>';

      var body;
      if (pd.status === 'resolvida') {
        var actionLabel = pd.acao === 'faturar' ? 'diária faturada' : 'diária não faturada';
        body = '<div style="padding:14px 16px; background:var(--success-bg); border:1px solid var(--success-border); border-radius:5px;">'
          + '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' + icon('check', 'style="color:var(--success)"')
          + '<span style="font-size:12.5px; font-weight:700; color:var(--success);">Resolvida — ' + actionLabel + '</span>'
          + '<a onclick="App.editPend(\'' + pd.id + '\')" style="margin-left:auto; font-size:12px; font-weight:600;">' + (busy ? spinner(true) : 'Editar') + '</a></div>'
          + '<div style="font-size:12.5px; color:var(--text-secondary); line-height:1.5;"><strong>Justificativa:</strong> ' + esc(pd.justificativa) + '</div></div>';
      } else {
        var d = draft(pd.id);
        var activeBtn = 'background:var(--accent); color:#fff; border-color:var(--accent);';
        var idleBtn = 'background:var(--surface); color:var(--text); border-color:var(--border-strong);';
        var canSave = d.acao && d.justificativa && d.justificativa.trim().length > 0;
        body = '<div>'
          +   '<div style="display:flex; gap:8px; margin-bottom:14px;">'
          +     '<button class="btn" style="' + (d.acao === 'faturar' ? activeBtn : idleBtn) + '" ' + (busy ? 'disabled' : '') + ' onclick="App.setPendAction(\'' + pd.id + '\',\'faturar\')">Faturar esta diária</button>'
          +     '<button class="btn" style="' + (d.acao === 'nao_faturar' ? activeBtn : idleBtn) + '" ' + (busy ? 'disabled' : '') + ' onclick="App.setPendAction(\'' + pd.id + '\',\'nao_faturar\')">Não faturar esta diária</button>'
          +   '</div>'
          +   '<label class="label">Justificativa (obrigatória)</label>'
          +   '<textarea class="field" data-field="just-' + pd.id + '" rows="3" ' + (busy ? 'disabled' : '') + ' placeholder="Descreva o motivo da decisão para fins de auditoria..." oninput="App.setPendJust(\'' + pd.id + '\', this.value)">' + esc(d.justificativa) + '</textarea>'
          +   '<div style="display:flex; align-items:flex-start; gap:8px; margin-top:10px; padding:10px 12px; background:var(--accent-soft); border-radius:5px;">'
          +     icon('info', 'style="color:var(--accent)"')
          +     '<div style="font-size:11.5px; color:var(--accent); line-height:1.5;">Esta justificativa vai para o relatório de auditoria/pendências. Ela <strong>não entra</strong> no relatório de faturamento.</div>'
          +   '</div>'
          +   '<div style="display:flex; justify-content:flex-end; margin-top:12px;"><button class="btn btn-primary" ' + (!canSave || busy ? 'disabled' : '') + ' onclick="App.savePend(\'' + pd.id + '\')">' + (busy ? spinner() : 'Salvar decisão') + '</button></div>'
          + '</div>';
      }
      return '<div class="card" style="padding:20px;">' + header + body + '</div>';
    }).join('');

    return '<div style="max-width:760px;">'
    + '<div style="font-size:13.5px; color:var(--text-secondary); margin-bottom:20px;">' + summary + '</div>'
    + (cards ? '<div style="display:flex; flex-direction:column; gap:16px;">' + cards + '</div>' : '<div class="card" style="padding:48px; text-align:center; color:var(--text-muted); font-size:13px;">' + icon('check', 'style="stroke:var(--success)" width="28" height="28"') + '<div style="margin-top:8px;">Nenhuma pendência registrada ainda.</div></div>')
    + '<div style="display:flex; justify-content:flex-start; margin-top:24px;"><button class="btn btn-secondary" onclick="App.goTo(\'dashboard\')">← Voltar ao início</button></div>'
    + '</div>';
  }

  // ================= RENDER: CONVÊNIOS =================

  function switchHtml(on, onclick, disabled) {
    return '<button type="button" class="switch' + (on ? ' on' : '') + '" ' + (disabled ? 'disabled' : '') + ' onclick="' + onclick + '"><span class="knob"></span></button>';
  }

  function renderConvenios() {
    var formHtml = '';
    if (state.novoConvenioAberto) {
      var saveDisabled = !(state.novoNome.trim() && state.novoValor.trim() && state.novoDesde) || state.convenioBusy;
      formHtml = '<div class="card" style="padding:20px; margin-bottom:20px; border-color:var(--accent-soft-strong);">'
        + '<div style="font-size:14px; font-weight:700; margin-bottom:16px;">Novo convênio</div>'
        + '<div style="display:grid; grid-template-columns:1.4fr 1fr 1fr 1fr; gap:14px; margin-bottom:16px;">'
        +   '<div><label class="label">Nome do convênio</label><input class="field" data-field="novo-nome" type="text" placeholder="Ex.: Bradesco Saúde" value="' + esc(state.novoNome) + '" oninput="App.setNovoField(\'novoNome\', this.value)" /></div>'
        +   '<div><label class="label">Periodicidade</label><select class="field" data-field="novo-period" onchange="App.setNovoField(\'novoPeriodicidade\', this.value)">'
        +     '<option value="mensal_calendario" ' + (state.novoPeriodicidade === 'mensal_calendario' ? 'selected' : '') + '>Mensal (calendário)</option>'
        +     '<option value="mensal_21_20" ' + (state.novoPeriodicidade === 'mensal_21_20' ? 'selected' : '') + '>Mensal (21 a 20)</option>'
        +     '<option value="semanal" ' + (state.novoPeriodicidade === 'semanal' ? 'selected' : '') + '>Semanal</option>'
        +   '</select></div>'
        +   '<div><label class="label">Valor da diária (R$)</label><input class="field" data-field="novo-valor" type="text" placeholder="Ex.: 620,00" value="' + esc(state.novoValor) + '" oninput="App.setNovoField(\'novoValor\', this.value)" /></div>'
        +   '<div><label class="label">Vigente desde</label><input class="field" data-field="novo-desde" type="date" value="' + esc(state.novoDesde) + '" onblur="App.setNovoField(\'novoDesde\', this.value)" /></div>'
        + '</div>'
        + '<div style="display:flex; justify-content:flex-end; gap:10px;"><button class="btn btn-secondary" ' + (state.convenioBusy ? 'disabled' : '') + ' onclick="App.cancelarNovoConvenio()">Cancelar</button>'
        + '<button class="btn btn-primary" ' + (saveDisabled ? 'disabled' : '') + ' onclick="App.salvarNovoConvenio()">' + (state.convenioBusy ? spinner() : 'Salvar convênio') + '</button></div>'
        + '</div>';
    }

    var list = state.convenios.map(function (cv) {
      var expanded = state.expandedConvenioId === cv.id;
      var regras = firstOrSelf(cv.convenio_regras_evento) || {};
      var historico = (cv.convenio_valores_vigencia || []).slice().sort(function (a, b) { return a.vigencia_inicio < b.vigencia_inicio ? 1 : -1; });
      var atual = historico.filter(function (h) { return !h.vigencia_fim; })[0] || historico[0];
      var head = '<div style="padding:16px 20px; display:flex; align-items:center; gap:20px; cursor:pointer;" onclick="App.toggleConvenio(\'' + cv.id + '\')">'
        + '<svg class="icon chevron' + (expanded ? ' open' : '') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'
        + '<div style="font-size:14px; font-weight:700; width:160px;">' + esc(cv.nome) + '</div>'
        + '<div style="font-size:12.5px; color:var(--text-secondary); width:170px;">' + PERIODICIDADE_LABEL[cv.periodicidade] + '</div>'
        + '<div style="font-size:13px; font-weight:600;" class="mono">' + (atual ? brl(atual.valor_diaria) : '—') + '</div>'
        + '<div style="font-size:12px; color:var(--text-muted);">' + (atual ? 'vigente desde ' + fmtBR(atual.vigencia_inicio) : '') + '</div>'
        + '<a class="btn-danger-ghost" style="margin-left:auto;" onclick="App.removerConvenio(event,\'' + cv.id + '\')">Remover</a>'
        + '</div>';
      var detail = '';
      if (expanded) {
        var histRows = historico.map(function (hv) {
          return '<tr><td class="mono">' + fmtBR(hv.vigencia_inicio) + '</td><td class="mono">' + (hv.vigencia_fim ? fmtBR(hv.vigencia_fim) : '—') + '</td><td class="mono" style="font-weight:600;">' + brl(hv.valor_diaria) + '</td></tr>';
        }).join('');
        var novaVigenciaForm = state.novaVigenciaAberta === cv.id
          ? '<div style="display:flex; gap:8px; margin-top:10px; align-items:flex-end;">'
            + '<div style="flex:1;"><label class="label">Novo valor (R$)</label><input class="field" data-field="nova-vig-valor" type="text" value="' + esc(state.novaVigenciaValor) + '" oninput="App.setNovaVigenciaField(\'novaVigenciaValor\', this.value)"/></div>'
            + '<div style="flex:1;"><label class="label">Vigente a partir de</label><input class="field" data-field="nova-vig-desde" type="date" value="' + esc(state.novaVigenciaDesde) + '" onblur="App.setNovaVigenciaField(\'novaVigenciaDesde\', this.value)"/></div>'
            + '<button class="btn btn-secondary" onclick="App.cancelarNovaVigencia()">Cancelar</button>'
            + '<button class="btn btn-primary" onclick="App.salvarNovaVigencia(\'' + cv.id + '\')">Salvar</button>'
            + '</div>'
          : '<a onclick="App.abrirNovaVigencia(\'' + cv.id + '\')" style="font-size:12.5px; font-weight:600; display:inline-block; margin-top:10px;">+ Novo valor vigente</a>';
        detail = '<div style="padding:0 20px 20px 20px; border-top:1px solid var(--border);">'
          + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:24px; padding-top:18px;">'
          +   '<div><div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-muted); margin-bottom:10px;">Regras por evento</div>'
          +   '<div style="display:flex; flex-direction:column; gap:10px;">'
          +     '<div style="display:flex; align-items:center; gap:10px;">' + switchHtml(regras.alta_conta_ultima_diaria, "App.toggleRegraBool('" + cv.id + "','alta_conta_ultima_diaria')", state.convenioBusy) + '<div style="font-size:13px;">Alta — conta a última diária</div></div>'
          +     '<div style="display:flex; align-items:center; gap:10px;">' + switchHtml(regras.obito_conta_ultima_diaria, "App.toggleRegraBool('" + cv.id + "','obito_conta_ultima_diaria')", state.convenioBusy) + '<div style="font-size:13px;">Óbito — conta a última diária</div></div>'
          +     '<div style="display:flex; align-items:center; gap:10px;">' + switchHtml(regras.transferencia_conta_ultima_diaria, "App.toggleRegraBool('" + cv.id + "','transferencia_conta_ultima_diaria')", state.convenioBusy) + '<div style="font-size:13px;">Transferência — conta a última diária</div></div>'
          +     '<div style="display:flex; align-items:center; gap:10px; padding-left:2px;"><div style="font-size:13px; color:var(--text-secondary);">Tolerância de ausência (horas)</div>'
          +       '<input class="field" data-field="tol-' + cv.id + '" type="number" style="width:80px;" value="' + regras.ausencia_tolerancia_horas + '" onchange="App.setTolerancia(\'' + cv.id + '\', this.value)" /></div>'
          +   '</div></div>'
          +   '<div><div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-muted); margin-bottom:10px;">Histórico de vigência — valor da diária</div>'
          +   '<div class="table-wrap"><table style="border:1px solid var(--border); border-radius:5px; overflow:hidden;"><thead><tr><th>Início</th><th>Fim</th><th>Valor</th></tr></thead><tbody>' + histRows + '</tbody></table></div>'
          +   novaVigenciaForm
          +   '</div>'
          + '</div></div>';
      }
      return '<div class="card">' + head + detail + '</div>';
    }).join('');

    return '<div style="display:flex; justify-content:flex-end; margin-bottom:16px;"><button class="btn btn-primary" onclick="App.abrirNovoConvenio()">+ Novo convênio</button></div>'
      + formHtml
      + (list ? '<div style="display:flex; flex-direction:column; gap:12px;">' + list + '</div>' : '<div class="card" style="padding:48px; text-align:center; color:var(--text-muted); font-size:13px;">Nenhum convênio cadastrado.</div>');
  }

  // ================= RENDER: HISTÓRICO =================

  function renderHistorico() {
    var rows = state.historico.map(historicoRowHtml).join('');
    return '<div class="card">' + (rows
      ? '<div class="table-wrap"><table><thead><tr><th>Competência</th><th>Convênio</th><th>Período</th><th>Processado em</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div style="padding:48px; text-align:center; color:var(--text-muted); font-size:13px;">Nenhum processamento registrado ainda.</div>') + '</div>';
  }

  // ================= RENDER: EXPORTAÇÃO =================

  function renderExportacao() {
    if (!state.processView) {
      return '<div class="alert alert-warning">' + icon('alert') + 'Abra um processamento (pelo Histórico ou processando um novo censo) antes de exportar.</div>';
    }
    var v = state.processView;
    return '<div style="max-width:840px;">'
    + '<div style="font-size:13px; color:var(--text-secondary); margin-bottom:20px;">' + esc(v.convenioNome) + ' · Competência ' + esc(v.competencia) + ' · ' + v.periodoLabel + '</div>'
    + (state.exportMsg ? '<div class="alert alert-success" style="margin-bottom:20px;">' + icon('check') + '<div style="flex:1;">' + esc(state.exportMsg.texto) + ' <a href="' + state.exportMsg.url + '" target="_blank" rel="noopener" style="font-weight:700;">Baixar arquivo</a></div><a onclick="App.fecharExportMsg()" style="font-weight:600;">✕</a></div>' : '')
    + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">'
    +   '<div class="card" style="padding:22px;">' + icon('doc', 'style="color:var(--accent)"')
    +     '<div style="font-size:14.5px; font-weight:700; margin:8px 0 6px;">Relatório de faturamento</div>'
    +     '<div style="font-size:12.5px; color:var(--text-secondary); line-height:1.6; margin-bottom:18px;">Documento limpo com os valores finais por paciente, pronto para envio.</div>'
    +     '<div style="display:flex; gap:10px;">'
    +       '<button class="btn btn-secondary" ' + (state.exportBusy ? 'disabled' : '') + ' onclick="App.exportar(\'faturamento\',\'excel\')">' + (state.exportBusy ? spinner(true) : 'Exportar Excel') + '</button>'
    +       '<button class="btn btn-secondary" ' + (state.exportBusy ? 'disabled' : '') + ' onclick="App.exportar(\'faturamento\',\'pdf\')">Exportar PDF</button>'
    +     '</div>'
    +   '</div>'
    +   '<div class="card" style="padding:22px;">' + icon('alert', 'style="color:var(--warning)"')
    +     '<div style="font-size:14.5px; font-weight:700; margin:8px 0 6px;">Relatório de pendências e justificativas</div>'
    +     '<div style="font-size:12.5px; color:var(--text-secondary); line-height:1.6; margin-bottom:18px;">Documento de auditoria com os casos revisados manualmente. Não entra no relatório de faturamento.</div>'
    +     '<div style="display:flex; gap:10px;">'
    +       '<button class="btn btn-secondary" ' + (state.exportBusy ? 'disabled' : '') + ' onclick="App.exportar(\'pendencias\',\'excel\')">Exportar Excel</button>'
    +       '<button class="btn btn-secondary" ' + (state.exportBusy ? 'disabled' : '') + ' onclick="App.exportar(\'pendencias\',\'pdf\')">Exportar PDF</button>'
    +     '</div>'
    +   '</div>'
    + '</div></div>';
  }

  // ================= INIT =================

  async function init() {
    render();
    if (!DB.isConfigured()) { return; }
    await guarded(null, async function () {
      var session = await DB.getSession();
      if (session) { state.session = session; await afterLogin(); }
    });
    render();
  }
  init();
})();
