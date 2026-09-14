/**
 * Gerador de UUID que funciona fora de contexto seguro.
 *
 * `crypto.randomUUID()` só existe em contexto seguro — HTTPS ou localhost.
 * Um PDV acessado pelo IP da rede (`http://192.168.0.10:3000`) NÃO é contexto
 * seguro, e a função simplesmente não existe ali: a tela quebrava inteira com
 * "crypto.randomUUID is not a function".
 *
 * `crypto.getRandomValues()`, ao contrário, está disponível também em HTTP,
 * então é ele que sustenta o caminho alternativo — mantendo aleatoriedade
 * criptográfica de verdade, não `Math.random`.
 */

function fromRandomValues(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Marca versão 4 e variante RFC 4122, como um UUID legítimo.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Último recurso, para ambientes sem Web Crypto algum (jsdom antigo, WebView
 * exótica). Não é criptográfico — serve só para não derrubar a interface.
 */
function fromMathRandom(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function uuid(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto.getRandomValues === 'function') return fromRandomValues();
  }
  return fromMathRandom();
}
