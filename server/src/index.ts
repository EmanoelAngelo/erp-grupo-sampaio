import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { logError, logInfo, logWarn } from './utils/errors.js';
import { avisarSeOFusoDiverge } from './services/core/fusoDaLoja.js';
import { closeConnection } from './db/sqlite.js';
import { criarDesligamento, instalarRedeDeSeguranca } from './services/implantacao/cicloDoProcesso.js';
import { BancoOcupado, ESPERA_DA_API_MS, assumirInstancia } from './services/implantacao/instanciaUnica.js';
import { prepararBanco } from './db/migracaoCompleta.js';
import { BootstrapRecusado, executarBootstrap } from './db/bootstrap.js';
import { startMailScheduler, stopMailScheduler } from './services/core/MailInboxScheduler.js';
import {
  carteiroConfigurado,
  startEmailFlushWorker,
  stopEmailFlushWorker,
} from './services/notifications/EmailService.js';
import { startReservationExpiry, stopReservationExpiry } from './services/core/OrderReservationExpiry.js';
import { startRastreioAgendado, stopRastreioAgendado } from './services/logistics/RastreioAgendado.js';
import { startAsaasSync, stopAsaasSync } from './services/core/AsaasSincronizacaoScheduler.js';
import { startDailyBackup, stopDailyBackup } from './db/backup.js';
import {
  startContadorScheduler,
  stopContadorScheduler,
} from './services/core/ContadorEnvioService.js';
import {
  startSyncWorker,
  stopSyncWorker,
  supabaseConfig,
} from './services/sync/SyncService.js';
import {
  startFiscalQueueWorker,
  stopFiscalQueueWorker,
} from './services/core/FiscalQueueWorker.js';

export async function startServer(): Promise<void> {
  const env = loadEnv();

  /*
    UMA INSTÂNCIA POR ARQUIVO DE BANCO (GAP-PRD-137) — antes de migrar e antes
    da porta.

    Dois processos no mesmo `.db` "quase" funcionavam: a escrita serializa, mas
    a espera passa de 5 s e a venda recebe "database is locked"; os
    trabalhadores de fundo dobram (o mesmo e-mail sai duas vezes); e dois boots
    juntos aplicam o mesmo passo de migração. A trava vem PRIMEIRO porque é ela
    que protege a migração logo abaixo.

    Espera até 12 s o dono anterior sair (o desligamento limpo leva até 8 s) e
    então recusa com a frase que diz quem é o dono. Dono morto na mesma máquina
    (queda, tarefa encerrada à força, `tsx watch` que matou o filho) não
    espera nada: o pid não existe mais, e esta subida assume na hora.
  */
  let aoPerderODono: () => void = () => undefined;
  const trava = await assumirInstancia('api', {
    esperaMs: ESPERA_DA_API_MS,
    aoPerder: (dono) => {
      logError('INSTANCIA_PERDIDA', { dono: dono ?? undefined });
      aoPerderODono();
    },
  });

  // Leva um banco já existente até o formato atual sem apagar nada (documentos
  // e núcleo), e garante que as duas oficinas oficiais existam. É a MESMA
  // função do `npm run db:migrate` (GAP-PRD-056): upgrade a frio e subida
  // fazem exatamente o mesmo.
  try {
    prepararBanco();
    /*
      O BOOTSTRAP DE PRODUÇÃO, logo depois do esquema: as seis empresas, as
      bancadas oficiais e — só num banco sem administrador do grupo — a conta
      `admin` com a senha de DEVORA_BOOTSTRAP_ADMIN_PASSWORD. Sem a variável,
      avisa no log e sobe (a conferência da implantação BLOQUEIA); com senha
      fraca, recusa subir antes de criar qualquer coisa. Nunca altera conta
      existente, e é o mesmo do `db:bootstrap`/`db:seed`.
    */
    await executarBootstrap({ origem: 'subida' });
  } catch (err) {
    trava.liberar();
    throw err;
  }

  // O corte do dia no SQL (deslocamento fixo) ainda bate com o fuso oficial,
  // hoje e pelos próximos ~13 meses? (GAP-PRD-145) Só avisa no log — e a tela
  // Sistema mostra o mesmo: relatório divergindo não é motivo para a venda parar.
  avisarSeOFusoDiverge(logWarn);
  const app = createApp();
  const server = createServer(app);

  /*
    A REDE DE SEGURANÇA SOBE ANTES DA PORTA (GAP-PRD-063).

    `pararTrabalhadores` diz QUAIS laços descem; `criarDesligamento` põe prazo
    (8 s, dentro dos 10 s do `docker stop`), corta a conexão que não terminou
    e fecha o SQLite antes de sair. `instalarRedeDeSeguranca` liga SIGINT,
    SIGTERM, o pedido do supervisor pelo IPC, e registra a rejeição não
    tratada (segue) e a exceção não tratada (desliga com 1 — o supervisor
    sobe de novo). Parar um trabalhador que ainda não subiu é inofensivo:
    cada `stop*` confere o próprio timer.
  */
  const pararTrabalhadores = () => {
    stopMailScheduler();
    stopReservationExpiry();
    stopDailyBackup();
    stopSyncWorker();
    stopEmailFlushWorker();
    stopContadorScheduler();
    stopAsaasSync();
    stopRastreioAgendado();
    stopFiscalQueueWorker();
  };
  const desligar = criarDesligamento({
    servidor: server,
    pararTrabalhadores,
    // Solta a linha de dono ANTES de fechar: a próxima subida não espera nada.
    fecharBanco: () => {
      trava.liberar();
      closeConnection();
    },
    sair: (codigo) => process.exit(codigo),
  });
  instalarRedeDeSeguranca(process, desligar);
  // Outro processo assumiu o banco (este ficou mudo por mais que o prazo):
  // dois donos é o que a trava existe para impedir — este desce com 1.
  aoPerderODono = () => void desligar('instancia_perdida', 1);

  await new Promise<void>((resolve) => {
    server.listen(env.DEVORA_API_PORT, () => {
      logInfo('API_SERVER_STARTED', { port: env.DEVORA_API_PORT, env: env.DEVORA_API_ENV });
      resolve();
    });
  });

  // Leitura automática das caixas de e-mail. Roda no backend, independente de
  // qualquer navegador aberto.
  startMailScheduler();

  // A reserva de estoque do pedido não pago expira com o PIX (rodada 34).
  // Roda no backend: um pedido que venceu de madrugada volta à vitrine de
  // madrugada, sem esperar alguém abrir a tela.
  startReservationExpiry();

  // A conciliação pergunta ao Asaas (GAP-PRD-016): as cobranças em aberto são
  // consultadas no provedor sozinhas, e o webhook perdido deixa de sumir.
  logInfo('ASAAS_SYNC_STARTED', { intervaloMinutos: startAsaasSync() });

  // Backup diário no backend (rodada 35). Roda ao subir — o servidor pode ter
  // passado dias desligado — e a cada 24 h. Avisa no log enquanto o destino
  // for o mesmo disco do banco.
  startDailyBackup();

  /**
   * A FILA SÓ SOBE SE ALGUÉM A SUBIR.
   *
   * O trabalhador de fundo existia inteiro — envio em lote, upsert idempotente,
   * baixa só do que a central confirmou — e nunca era ligado: `startSyncWorker`
   * não tinha um único chamador. A tela dizia "a fila sobe sozinha" e não subia
   * nada; o gestor teria de clicar em "sincronizar agora" para sempre.
   *
   * E ELE SOBE SEMPRE — o `if` que estava aqui não protegia de nada.
   *
   * O molde era: sem credencial não há para onde enviar, então nem ligue o
   * timer. A premissa não se sustenta. `syncOnce` sem credencial devolve
   * `READY_FOR_CREDENTIAL` e volta na hora, sem tocar a rede e sem mexer na
   * fila. Bater a cada quinze segundos contra isso custa uma comparação.
   *
   * O que o `if` criava era dependência de ORDEM: o trabalhador existia ou
   * não conforme o estado do ambiente no instante EXATO em que o processo
   * subiu. Quem preenchesse a credencial com o servidor no ar não ligava nada
   * — e continuava sem ligar até alguém reiniciar por outro motivo.
   *
   * É o mesmo conserto que o carteiro de saída recebeu, pelo mesmo motivo. Lá
   * a fila presa segurava código de verificação e recuperação de senha; aqui
   * segura venda, estoque e fiscal a caminho da central.
   *
   * O estado continua sendo dito no log, porque quem está configurando
   * precisa saber por que nada subiu ainda — e agora ele diz QUAL nome falta.
   */
  startSyncWorker();
  logInfo('CENTRAL_SYNC_WORKER_STARTED', {
    credencial: supabaseConfig()
      ? 'configurada'
      : 'ausente (DEVORA_SUPABASE_URL + DEVORA_SUPABASE_SERVICE_KEY) — a fila acumula',
  });

  /*
    O CARTEIRO DE SAÍDA SAI SEMPRE — e aqui ele deixou de copiar o molde acima.

    Era `if (carteiroConfigurado()) startEmailFlushWorker()`, igual ao
    trabalhador da central, que na época subia sob `if (supabaseConfig())`.
    Aquele `if` também caiu, e pelo mesmo motivo que este caiu antes: a
    batida sem credencial JÁ é inofensiva — `fazerFlush` devolve
    `READY_FOR_CREDENTIAL` e volta sem tocar em nada, sem contar tentativa
    contra a mensagem. Quer dizer que o `if` não protegia de nada e só criava
    uma dependência de ORDEM: o carteiro existia ou não conforme o estado do
    ambiente no instante em que o processo subiu. Quem sobe o servidor antes de
    terminar de preencher o `.env` ficava com a fila parada — e nela ficam o
    código de verificação da conta do cliente e a recuperação de senha.

    O estado continua sendo dito no log, porque quem está configurando precisa
    saber por que nada saiu ainda.
  */
  startEmailFlushWorker();
  logInfo('CARTEIRO_SAIDA_STARTED', {
    credencial: carteiroConfigurado() ? 'configurada' : 'ausente (EMAIL_*) — a fila acumula',
  });

  // A agenda do contador segue o mesmo molde: liga sempre, e sem destinatário
  // ou sem SMTP ela apenas anota — o envio do mês devido sai quando o cadastro
  // e a credencial existirem, sem reiniciar nada.
  startContadorScheduler();

  // O rastreio dos envios a caminho, consultado no provedor (GAP-PRD-119).
  startRastreioAgendado();

  // A fila fiscal anda sozinha (GAP-PRD-020): a nota presa pela SEFAZ fora do
  // ar é transmitida quando o serviço volta, e não na próxima venda da mesma
  // empresa. Liga sempre — sem A1 no cofre a passada só anota a espera. A
  // parada mora em `pararTrabalhadores`, com os outros.
  startFiscalQueueWorker();
}

// `pathToFileURL` produz a mesma forma que `import.meta.url` em todas as
// plataformas. Montar a URL à mão quebrava no Windows, onde o caminho vira
// `file:///C:/...` (três barras) e a comparação nunca batia — de modo que
// `npm run dev` subia o processo sem jamais abrir a porta.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startServer().catch((err) => {
    // O banco com dono e a senha inicial recusada são recusas esperadas: a
    // frase basta, sem pilha (e a do bootstrap nunca carrega o valor).
    console.error(err instanceof BancoOcupado || err instanceof BootstrapRecusado ? err.message : err);
    process.exit(1);
  });
}
