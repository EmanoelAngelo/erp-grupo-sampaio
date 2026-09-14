/**
 * A integridade do pacote do contador (GAP-PRD-176).
 *
 * Cada entrega do pacote — download pela tela ou envio por e-mail — deixa o
 * SHA-256 do zip e o do MANIFESTO.csv na trilha do servidor. Esta chamada
 * pergunta se um hash informado é de alguma dessas entregas, desta empresa.
 */
import { apiRequest } from './client';

export interface OcorrenciaDoPacote {
  /** De qual arquivo é o hash: o zip inteiro ou o MANIFESTO.csv de dentro. */
  arquivo: 'zip' | 'manifesto';
  /** Como a entrega saiu: baixada pela tela ou enfileirada por e-mail. */
  meio: 'download' | 'email';
  period: string | null;
  nomeArquivo: string | null;
  quando: string;
  userId: string | null;
}

export interface ConferenciaDoPacote {
  sha256: string;
  encontrado: boolean;
  ocorrencias: OcorrenciaDoPacote[];
}

/** O cabeçalho em que o download diz o SHA-256 do zip que entregou. */
export const CABECALHO_DO_HASH = 'x-pacote-sha256';

export const pacoteDoContadorApi = {
  conferir: (sha256: string) =>
    apiRequest<ConferenciaDoPacote>(
      `/core/fiscal/closings/conferir?sha256=${encodeURIComponent(sha256.trim())}`,
    ),
};

/**
 * SHA-256 de um arquivo escolhido na tela, calculado NO NAVEGADOR — o arquivo
 * não sobe para o servidor. Nulo quando o navegador não oferece a Web Crypto
 * (página fora de HTTPS, por exemplo); aí a tela pede o número colado.
 */
export async function sha256DoArquivo(arquivo: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof arquivo.arrayBuffer !== 'function') return null;
  const resumo = await subtle.digest('SHA-256', await arquivo.arrayBuffer());
  return [...new Uint8Array(resumo)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
