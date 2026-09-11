// Cliente Supabase + acesso a dados. Tudo aqui faz chamadas de rede reais.
(function () {
  "use strict";

  var cfg = window.VITA_CONFIG || {};
  var client = null;

  function getClient() {
    if (!client) {
      if (!window.supabase || !window.supabase.createClient) {
        throw new Error('Biblioteca do Supabase não carregou. Verifique a conexão e o script no index.html.');
      }
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    }
    return client;
  }

  function isConfigured() {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
      && cfg.SUPABASE_URL.indexOf('SEU-PROJETO') === -1
      && cfg.SUPABASE_ANON_KEY.indexOf('SUA-CHAVE') === -1);
  }

  function unwrap(result) {
    if (result.error) { throw result.error; }
    return result.data;
  }

  // ---------------- Auth ----------------

  async function signIn(email, password) {
    var res = await getClient().auth.signInWithPassword({ email: email, password: password });
    return unwrap(res);
  }

  async function signUp(email, password, metadata) {
    var res = await getClient().auth.signUp({ email: email, password: password, options: { data: metadata } });
    return unwrap(res);
  }

  async function signOut() {
    await getClient().auth.signOut();
  }

  async function getSession() {
    var res = await getClient().auth.getSession();
    return unwrap(res).session;
  }

  function onAuthChange(cb) {
    getClient().auth.onAuthStateChange(function (_event, session) { cb(session); });
  }

  async function getMyProfile(userId) {
    var res = await getClient().from('profiles').select('*').eq('id', userId).single();
    return unwrap(res);
  }

  // ---------------- Convênios ----------------

  async function listConvenios() {
    var res = await getClient()
      .from('convenios')
      .select('*, convenio_valores_vigencia(*), convenio_regras_evento(*)')
      .order('nome', { ascending: true });
    return unwrap(res);
  }

  async function createConvenio(payload) {
    var res = await getClient().from('convenios').insert(payload).select().single();
    var convenio = unwrap(res);
    await getClient().from('convenio_regras_evento').insert({
      convenio_id: convenio.id,
      alta_conta_ultima_diaria: true,
      obito_conta_ultima_diaria: true,
      transferencia_conta_ultima_diaria: false,
      ausencia_conta_ultima_diaria: false,
      ausencia_tolerancia_horas: 24
    });
    return convenio;
  }

  async function deleteConvenio(id) {
    var res = await getClient().from('convenios').delete().eq('id', id);
    unwrap(res);
  }

  async function addValorVigencia(convenioId, valor, inicio) {
    // Fecha a vigência aberta anterior (fim = dia antes do novo início) e abre uma nova.
    var abertaRes = await getClient()
      .from('convenio_valores_vigencia')
      .select('*')
      .eq('convenio_id', convenioId)
      .is('vigencia_fim', null)
      .maybeSingle();
    var aberta = unwrap(abertaRes);
    if (aberta) {
      var diaAnterior = new Date(inicio + 'T00:00:00Z');
      diaAnterior.setUTCDate(diaAnterior.getUTCDate() - 1);
      await getClient().from('convenio_valores_vigencia')
        .update({ vigencia_fim: diaAnterior.toISOString().slice(0, 10) })
        .eq('id', aberta.id);
    }
    var res = await getClient().from('convenio_valores_vigencia').insert({
      convenio_id: convenioId, valor_diaria: valor, vigencia_inicio: inicio, vigencia_fim: null
    }).select().single();
    return unwrap(res);
  }

  async function updateRegraEvento(convenioId, patch) {
    var res = await getClient().from('convenio_regras_evento').update(patch).eq('convenio_id', convenioId).select().single();
    return unwrap(res);
  }

  // ---------------- Storage ----------------

  async function uploadCenso(file) {
    var path = Date.now() + '_' + file.name.replace(/[^\w.\-]+/g, '_');
    var res = await getClient().storage.from('censos').upload(path, file, { upsert: false });
    unwrap(res);
    return path;
  }

  async function uploadRelatorio(path, blob, contentType) {
    var res = await getClient().storage.from('relatorios').upload(path, blob, { upsert: true, contentType: contentType });
    unwrap(res);
    var signed = await getClient().storage.from('relatorios').createSignedUrl(path, 60 * 30);
    return unwrap(signed).signedUrl;
  }

  // ---------------- Censo uploads ----------------

  async function insertCensoUpload(payload) {
    var res = await getClient().from('censo_uploads').insert(payload).select().single();
    return unwrap(res);
  }

  // ---------------- Processamentos ----------------

  async function insertProcessamento(payload) {
    var res = await getClient().from('processamentos').insert(payload).select().single();
    return unwrap(res);
  }

  async function insertPacientes(rows) {
    var res = await getClient().from('processamento_pacientes').insert(rows).select();
    return unwrap(res);
  }

  async function insertMemoria(rows) {
    if (!rows.length) { return []; }
    var res = await getClient().from('memoria_calculo_diaria').insert(rows).select();
    return unwrap(res);
  }

  async function insertPendencias(rows) {
    if (!rows.length) { return []; }
    var res = await getClient().from('pendencias').insert(rows).select();
    return unwrap(res);
  }

  async function listHistorico() {
    var res = await getClient()
      .from('processamentos')
      .select('*, convenios(nome)')
      .order('processado_em', { ascending: false });
    return unwrap(res);
  }

  async function getProcessamentoCompleto(id) {
    var procRes = await getClient().from('processamentos').select('*, convenios(nome)').eq('id', id).single();
    var proc = unwrap(procRes);
    var pacientesRes = await getClient().from('processamento_pacientes').select('*').eq('processamento_id', id).order('nome_paciente');
    var pacientes = unwrap(pacientesRes);
    var ids = pacientes.map(function (p) { return p.id; });
    var memoria = [];
    var pendencias = [];
    if (ids.length) {
      var memRes = await getClient().from('memoria_calculo_diaria').select('*').in('processamento_paciente_id', ids).order('data');
      memoria = unwrap(memRes);
      var pendRes = await getClient().from('pendencias').select('*').in('processamento_paciente_id', ids).order('criado_em');
      pendencias = unwrap(pendRes);
    }
    pacientes.forEach(function (p) {
      p.memoria = memoria.filter(function (m) { return m.processamento_paciente_id === p.id; });
      p.pendencias = pendencias.filter(function (pd) { return pd.processamento_paciente_id === p.id; });
    });
    return { processamento: proc, pacientes: pacientes };
  }

  async function updateProcessamentoStatus(id, status, totals) {
    var patch = Object.assign({ status: status }, totals || {});
    var res = await getClient().from('processamentos').update(patch).eq('id', id);
    unwrap(res);
  }

  // ---------------- Pendências (globais, para a tela de Resolução) ----------------

  // Traz abertas e resolvidas (a tela mostra as duas — resolvidas com um link
  // para reabrir/editar a decisão) para que uma decisão possa ser corrigida
  // sem precisar ir ao banco na mão. O badge do menu conta só as abertas.
  async function listPendencias() {
    var res = await getClient()
      .from('pendencias')
      .select('*, processamento_pacientes(nome_paciente, processamento_id, processamentos(competencia, convenios(nome)))')
      .order('status', { ascending: true })
      .order('criado_em', { ascending: true });
    return unwrap(res);
  }

  async function resolverPendencia(id, acao, justificativa, userId) {
    var res = await getClient().from('pendencias').update({
      status: 'resolvida', acao: acao, justificativa: justificativa,
      resolvido_por: userId, resolvido_em: new Date().toISOString()
    }).eq('id', id);
    unwrap(res);
  }

  async function reabrirPendencia(id) {
    var res = await getClient().from('pendencias').update({
      status: 'aberta', acao: null, justificativa: null, resolvido_por: null, resolvido_em: null
    }).eq('id', id);
    unwrap(res);
  }

  async function countPendenciasAbertasDoProcessamento(processamentoId) {
    var pacRes = await getClient().from('processamento_pacientes').select('id').eq('processamento_id', processamentoId);
    var pacientes = unwrap(pacRes);
    var ids = pacientes.map(function (p) { return p.id; });
    if (!ids.length) { return { abertas: 0, total: 0 }; }
    var res = await getClient().from('pendencias').select('status').in('processamento_paciente_id', ids);
    var all = unwrap(res);
    return { abertas: all.filter(function (p) { return p.status === 'aberta'; }).length, total: all.length };
  }

  // ---------------- Exportações ----------------

  async function insertExportacao(payload) {
    var res = await getClient().from('exportacoes').insert(payload).select().single();
    return unwrap(res);
  }

  window.VitaDB = {
    isConfigured: isConfigured,
    signIn: signIn, signUp: signUp, signOut: signOut, getSession: getSession, onAuthChange: onAuthChange, getMyProfile: getMyProfile,
    listConvenios: listConvenios, createConvenio: createConvenio, deleteConvenio: deleteConvenio,
    addValorVigencia: addValorVigencia, updateRegraEvento: updateRegraEvento,
    uploadCenso: uploadCenso, uploadRelatorio: uploadRelatorio,
    insertCensoUpload: insertCensoUpload,
    insertProcessamento: insertProcessamento, insertPacientes: insertPacientes, insertMemoria: insertMemoria,
    insertPendencias: insertPendencias, listHistorico: listHistorico, getProcessamentoCompleto: getProcessamentoCompleto,
    updateProcessamentoStatus: updateProcessamentoStatus,
    listPendencias: listPendencias, resolverPendencia: resolverPendencia, reabrirPendencia: reabrirPendencia,
    countPendenciasAbertasDoProcessamento: countPendenciasAbertasDoProcessamento,
    insertExportacao: insertExportacao
  };
})();
