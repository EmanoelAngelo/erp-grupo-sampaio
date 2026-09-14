/**
 * CLI do SEED DE DESENVOLVIMENTO: as doze contas de demonstração, só na bancada.
 *
 *     npm run db:seed:dev --prefix server
 *
 * Confere o ambiente e o caminho do banco ANTES de abrir o arquivo (recusa
 * produção, homologação e o banco operacional); só então assume o banco,
 * prepara o esquema como a subida e semeia.
 */
import {
  SeedDeDesenvolvimentoRecusado,
  conferirQuePodeSemearDesenvolvimento,
  relatorioDoSeedDeDesenvolvimento,
  semearDesenvolvimento,
} from './seedDeDesenvolvimento.js';
import { prepararBanco } from './migracaoCompleta.js';
import { closeConnection } from './sqlite.js';
import { BancoOcupado, assumirInstanciaAgora, type Trava } from '../services/implantacao/instanciaUnica.js';

async function main(): Promise<number> {
  try {
    conferirQuePodeSemearDesenvolvimento();
  } catch (err) {
    if (!(err instanceof SeedDeDesenvolvimentoRecusado)) throw err;
    console.error(err.message);
    console.error('Nada foi semeado.');
    return 1;
  }

  let trava: Trava;
  try {
    trava = assumirInstanciaAgora('manutencao');
  } catch (err) {
    if (!(err instanceof BancoOcupado)) throw err;
    console.error(err.message);
    console.error('Nada foi semeado.');
    return 1;
  }
  try {
    prepararBanco();
    const resultado = await semearDesenvolvimento();
    for (const linha of relatorioDoSeedDeDesenvolvimento(resultado)) console.log(linha);
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    console.error('Nada mais foi semeado.');
    return 1;
  } finally {
    trava.liberar();
    closeConnection();
  }
}

process.exitCode = await main();
