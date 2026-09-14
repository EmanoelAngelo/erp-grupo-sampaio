/**
 * AS AUTORIDADES DO ICP-BRASIL QUE O SERVIDOR PRECISA CONHECER — rodada 60.
 *
 * ============================================================================
 * O DEFEITO QUE ESTE MÓDULO FECHA
 * ============================================================================
 *
 * O dono testou a comunicação com a SEFAZ e leu:
 *
 *     unable to get local issuer certificate
 *
 * O erro não era do certificado dele — era do certificado que a SEFAZ
 * APRESENTA. A cadeia do webservice do RS é
 *
 *     *.sefazrs.rs.gov.br  ←  AC do SERPRO SSLv1  ←  AC Raiz Brasileira v10
 *
 * e a raiz é do ICP-Brasil. O Node embute a lista de autoridades da Mozilla,
 * que NÃO inclui a Raiz Brasileira: ela vive no truststore do sistema
 * operacional, que é onde o navegador a encontra. Sem ela, o Node não
 * consegue fechar a cadeia e recusa a conexão antes de qualquer XML.
 *
 * O diagnóstico enganou por um detalhe que vale registrar: o shell onde as
 * primeiras medições rodaram tinha `NODE_USE_SYSTEM_CA=1`, e a conexão
 * passava; o processo do servidor não tinha, e falhava. Mesma máquina, mesmo
 * Node, truststores diferentes — e a conclusão errada era a mais natural do
 * mundo ("aqui funciona").
 *
 * ============================================================================
 * POR QUE O CERTIFICADO VAI NO REPOSITÓRIO
 * ============================================================================
 *
 * `NODE_USE_SYSTEM_CA=1` resolveria em uma linha e quebraria na mudança de
 * servidor: num contêiner, num Linux de produção ou numa máquina nova, a
 * variável não existe e o sistema volta a falhar — com uma mensagem que fala
 * de certificado quando o problema é de configuração de processo, que é o
 * tipo de pista que faz alguém procurar por uma tarde.
 *
 * O arquivo é o certificado PÚBLICO da AC Raiz Brasileira v10, emitido pelo
 * ITI: é o mesmo que todo navegador carrega, não é segredo de ninguém, e
 * viaja com o código. Ele foi extraído do truststore do próprio sistema —
 * não de um download avulso —, e o teste o fixa por titular, emissor e
 * validade, para que uma troca silenciosa apareça em vermelho.
 *
 * ============================================================================
 * O QUE ISTO NÃO É
 * ============================================================================
 *
 * Não é `rejectUnauthorized: false`. A validação continua ligada e rigorosa —
 * o que muda é que o servidor passa a CONHECER a autoridade que assina os
 * webservices do fisco brasileiro. Desligar a validação faria a conexão
 * "funcionar" aceitando qualquer servidor que se dissesse a SEFAZ, que é
 * precisamente o que não se pode fazer quando o que trafega são documentos
 * assinados em nome da empresa.
 */
import { RAIZ_BRASILEIRA_V10_PEM } from './icp-brasil/raizes.js';

/** O titular da raiz, fixado para o teste conferir que é o certificado certo. */
export const RAIZ_ICP_BRASIL_SUBJECT = 'Autoridade Certificadora Raiz Brasileira v10';

/**
 * As autoridades que este servidor reconhece ao falar com o fisco.
 *
 * COMPILADAS, e não lidas do disco: o servidor de produção roda de `dist/` e
 * o `tsc` não copia `.pem` — um arquivo ao lado funcionaria aqui, sumiria no
 * build e derrubaria a emissão fiscal no primeiro dia de produção, com a
 * suíte inteira verde. Ver o comentário de `raizes.ts`.
 *
 * Uma lista, e não um certificado só: quando a raiz v11 chegar — ou quando
 * outra UF exigir outra AC —, o acréscimo é uma linha aqui, sem tocar em quem
 * consome.
 */
export function autoridadesConfiaveis(): string[] {
  return [RAIZ_BRASILEIRA_V10_PEM];
}
