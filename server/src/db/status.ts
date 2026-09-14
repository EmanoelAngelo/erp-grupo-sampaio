/**
 * `npm run db:status` — em que versão está o banco, e se é a desta build
 * (GAP-PRD-057).
 *
 * Imprimia `loadDb().version`: a camada de DOCUMENTOS, que parou em 19. O
 * número que muda com o código é o do NÚCLEO (`core_meta.core_schema_version`
 * contra `CORE_TARGET_VERSION`) — o checklist mandava conferir a versão por
 * este comando, e ele respondia outra. Pior: `loadDb()` CRIAVA as tabelas da
 * camada de documentos para poder medir, então rodar o status num caminho
 * errado deixava um banco novo lá.
 *
 * Agora abre o arquivo só para leitura (ou diz que ele não existe), e imprime
 * o JSON com a situação:
 *
 *   EM_DIA         núcleo = alvo, com todas as marcas de passo   (sai com 0)
 *   ATRASADO       núcleo abaixo do alvo, ou passo sem marca    (sai com 1)
 *   ADIANTADO      banco de uma build mais nova que esta         (sai com 1)
 *   NUNCA_MIGRADO  arquivo sem núcleo                            (sai com 1)
 *   SEM_BANCO      nada no caminho configurado                   (sai com 1)
 *
 * Em produção, sem o `tsx`: `node server/dist/db/status.js`.
 */
import { fraseDaSituacao, versoesDoArquivo } from './versaoDoEsquema.js';

const v = versoesDoArquivo();
console.log(
  JSON.stringify(
    {
      banco: v.caminho,
      situacao: v.situacao,
      nucleo: v.nucleo,
      documentos: v.documentos,
      frase: fraseDaSituacao(v),
    },
    null,
    2,
  ),
);
process.exitCode = v.situacao === 'EM_DIA' ? 0 : 1;
