/**
 * Contabilidad del consumo de IA (T'Controler, en systems.tcontroler del store
 * de Elvi-Ra). El coste se calcula en cada llamada con la tarifa del proveedor
 * que la atendió, así que cambiar de proveedor no revalora lo ya gastado.
 */

/** Coste en USD de un consumo según una tarifa; null si no hay tarifa. */
export function costOf(pricing, { inputTokens = 0, outputTokens = 0, webSearches = 0 }) {
  if (!pricing) return null;
  return (inputTokens / 1e6) * pricing.inputPerM
    + (outputTokens / 1e6) * pricing.outputPerM
    + webSearches * (pricing.perWebSearch || 0);
}

function emptyCounters() {
  return { inputTokens: 0, outputTokens: 0, webSearches: 0, calls: 0, costUsd: 0 };
}

function addTo(target, entry, cost) {
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.webSearches = (target.webSearches || 0) + entry.webSearches;
  target.calls += 1;
  target.costUsd = (target.costUsd || 0) + (cost ?? 0);
}

/**
 * Suma una llamada al T'Controler. Los tokens sin tarifa conocida (y los de
 * registros anteriores a la tarifa por llamada) se guardan aparte y se valoran
 * al leer con la tarifa vigente.
 */
export function addUsage(systems, entry) {
  const tc = systems.tcontroler || (systems.tcontroler = { status: 'local', tokensUsed: 0, tokensCap: 0 });
  if (!tc.byUser) tc.byUser = {};
  const u = tc.byUser[entry.user] || (tc.byUser[entry.user] = { ...emptyCounters(), operations: {} });

  if (u.costUsd === undefined) {
    u.unpricedInputTokens = u.inputTokens;
    u.unpricedOutputTokens = u.outputTokens;
    u.costUsd = 0;
  }
  if (entry.costUsd == null) {
    u.unpricedInputTokens = (u.unpricedInputTokens || 0) + entry.inputTokens;
    u.unpricedOutputTokens = (u.unpricedOutputTokens || 0) + entry.outputTokens;
  }
  addTo(u, entry, entry.costUsd);

  if (!u.operations) u.operations = {};
  const op = u.operations[entry.operation] || (u.operations[entry.operation] = emptyCounters());
  addTo(op, entry, entry.costUsd);

  u.lastCall = entry.at;
  u.lastProvider = entry.provider;
  u.lastModel = entry.model;
  tc.tokensUsed = Object.values(tc.byUser).reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
}

/** Coste acumulado de un usuario: el registrado por llamada más los tokens sin tarifa a la tarifa vigente. */
export function userCostUsd(u, pricing) {
  const legacy = u.costUsd === undefined;
  const unpriced = costOf(pricing, {
    inputTokens: legacy ? u.inputTokens : (u.unpricedInputTokens || 0),
    outputTokens: legacy ? u.outputTokens : (u.unpricedOutputTokens || 0),
  });
  return (legacy ? 0 : u.costUsd) + (unpriced ?? 0);
}
