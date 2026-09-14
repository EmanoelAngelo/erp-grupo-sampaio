/**
 * CLI do BOOTSTRAP DE PRODUÇÃO: as seis empresas do grupo, as bancadas
 * oficiais e o administrador inicial — nenhuma conta de demonstração.
 *
 *     npm run db:bootstrap --prefix server      (na bancada)
 *     npm run db:seed --prefix server           (o MESMO comando)
 *     node server/dist/db/bootstrap-cli.js      (no servidor)
 *
 * A subida da API faz exatamente o mesmo; este comando existe para o upgrade
 * "a frio" e para ver o relatório antes de abrir o balcão. Sai com 1 quando,
 * ao fim, ninguém administra o grupo (a variável não foi definida, ou o login
 * está ocupado) ou quando a senha inicial é recusada. Nunca imprime a senha.
 */
import { prepararBanco } from './migracaoCompleta.js';
import { closeConnection } from './sqlite.js';
import { BootstrapRecusado, executarBootstrap, relatorioDoBootstrap } from './bootstrap.js';
import { BancoOcupado, assumirInstanciaAgora, type Trava } from '../services/implantacao/instanciaUnica.js';

async function main(): Promise<number> {
  /*
    O bootstrap MIGRA e ESCREVE: com a API no ar seriam dois donos do mesmo
    banco (GAP-PRD-137). Recusa e diz quem está usando.
  */
  let trava: Trava;
  try {
    trava = assumirInstanciaAgora('manutencao');
  } catch (err) {
    if (!(err instanceof BancoOcupado)) throw err;
    console.error(err.message);
    console.error('Nada foi feito. A API no ar já roda o bootstrap ao subir; para rodá-lo à mão, pare-a antes.');
    return 1;
  }
  try {
    // O mesmo preparo da subida: documentos, núcleo, bancadas e plaquinha.
    prepararBanco();
    const resultado = await executarBootstrap({ origem: 'comando' });
    for (const linha of relatorioDoBootstrap(resultado)) console.log(linha);
    const alguemAdministra =
      resultado.administrador.situacao === 'criado'
      || (resultado.administrador.situacao === 'ja_existe' && resultado.administrador.motivo === 'administrador_do_grupo');
    return alguemAdministra ? 0 : 1;
  } catch (err) {
    if (err instanceof BootstrapRecusado) {
      console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    trava.liberar();
    closeConnection();
  }
}

process.exitCode = await main();
