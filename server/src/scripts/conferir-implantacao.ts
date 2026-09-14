/**
 * ============================================================================
 * CONFERIR A IMPLANTAÇÃO — antes de subir, e antes de instalar o serviço
 * ============================================================================
 *
 *     node server/dist/scripts/conferir-implantacao.js      (no servidor)
 *     npm run implantacao:conferir                         (na bancada)
 *
 * Roda na raiz da instalação, lê o `.env` como a API lê, e responde item por
 * item (ambiente, variável aposentada do acesso sem senha, chaves, origem das telas, HTTPS, proxy, quem
 * serve as telas, banco, fotos, backup, log, variáveis sem efeito). Sai com
 * código 1 se algo BLOQUEIA — `deploy/windows/instalar-servico.ps1` o roda e
 * para antes de registrar a tarefa.
 *
 * Nenhum valor de segredo é impresso: só os nomes.
 */
import { conferirImplantacao, contextoDoProcesso, type EstadoDoItem } from '../services/implantacao/conferenciaDaImplantacao.js';

const MARCA: Record<EstadoDoItem, string> = {
  OK: 'OK      ',
  INFO: 'INFO    ',
  ATENCAO: 'ATENCAO ',
  BLOQUEIA: 'BLOQUEIA',
};

function main(): number {
  const r = conferirImplantacao(contextoDoProcesso());
  console.log('=== CONFERÊNCIA DA IMPLANTAÇÃO ===');
  for (const item of r.itens) {
    console.log(`${MARCA[item.estado]}  ${item.titulo}: ${item.detalhe}`);
    if (item.comoResolver && item.estado !== 'OK') console.log(`          → ${item.comoResolver}`);
  }
  console.log('');
  console.log(
    `${r.resumo.OK} ok · ${r.resumo.INFO} informativo(s) · ${r.resumo.ATENCAO} atenção · ${r.resumo.BLOQUEIA} bloqueia`,
  );
  if (!r.pronto) {
    console.log('NÃO SUBA ASSIM: corrija o que bloqueia e rode de novo.');
    return 1;
  }
  console.log(
    r.resumo.ATENCAO > 0
      ? 'Nada bloqueia. Os itens em atenção são o que falta para a publicação ficar redonda.'
      : 'Nada bloqueia.',
  );
  return 0;
}

process.exit(main());
