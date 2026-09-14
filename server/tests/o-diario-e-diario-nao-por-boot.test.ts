/**
 * ============================================================================
 * "DIÁRIO" QUE RODA A CADA SUBIDA NÃO É DIÁRIO
 * ============================================================================
 *
 * `startDailyBackup` roda uma cópia ao subir e depois a cada 24 h. A cópia ao
 * subir tem um motivo bom, escrito no código: o servidor pode ter passado dias
 * desligado, e esperar 24 h para a primeira cópia deixaria uma janela sem
 * proteção nenhuma.
 *
 * O que faltava era a outra metade da frase — *se ainda não houver uma de
 * hoje*. Sem isso, cada subida do processo produz um arquivo de 5 MB e um
 * envio ao bucket.
 *
 * Medido em 27/08/2026, com o sistema ainda em desenvolvimento:
 *
 *     717 arquivos locais    3,6 GB    entre 18 e 27/08 — nove dias
 *     529 objetos no bucket  2,7 GB
 *
 * `tsx watch` reinicia o servidor a cada salvamento. Cada reinício, uma cópia.
 *
 * ## Por que isso não é só desperdício
 *
 * Primeiro, a poda local é por DATA — "30 dias, mínimo 7" —, então setecentos
 * arquivos de nove dias não são podados por nada. Segundo, o bucket não tem
 * poda nenhuma: cresce para sempre, e é armazenamento pago. Terceiro, e o que
 * mais importa: cada objeto é uma cópia INTEIRA do banco das seis empresas.
 * Multiplicar cópias multiplica exposição — foi exatamente esse número, 529,
 * que transformou "a chave de cifra era a padrão" num incidente com credencial
 * a trocar no portal do Asaas.
 *
 * Em produção o servidor reinicia pouco, e por isso é fácil considerar isto um
 * problema de bancada. Não é: um deploy que entra em laço de reinício, ou um
 * supervisor reerguendo um processo que morre, produz o mesmo efeito — só que
 * contra o bucket de produção.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { jaHaBackupDeHoje } = await import('../src/db/backup.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gs-diario-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Cria um arquivo de backup com a idade pedida, em horas. */
function backupCom(idadeEmHoras: number, motivo = 'diario'): string {
  const quando = new Date(Date.now() - idadeEmHoras * 60 * 60 * 1000);
  const carimbo = quando.toISOString().replace(/[:.]/g, '-');
  const nome = `grupo-sampaio-${carimbo}-${motivo}.db`;
  const caminho = join(dir, nome);
  writeFileSync(caminho, 'nao-e-um-banco-de-verdade');
  const segundos = quando.getTime() / 1000;
  utimesSync(caminho, segundos, segundos);
  return nome;
}

// ============================================================================

describe('já existe cópia de hoje?', () => {
  it('pasta vazia: não há — a primeira subida do dia copia', () => {
    expect(jaHaBackupDeHoje(dir)).toBe(false);
  });

  it('cópia de uma hora atrás: há — esta subida não copia de novo', () => {
    backupCom(1);
    expect(jaHaBackupDeHoje(dir)).toBe(true);
  });

  it('cópia de vinte e cinco horas atrás: não há — passou do dia', () => {
    /*
      A janela é de 20 h, não de 24 h exatas. Um servidor que sobe todo dia às
      8h05 e ontem subiu às 8h00 ficaria com 24h05 de intervalo — e com uma
      régua de 24 h exatas alternaria entre copiar e não copiar conforme o
      minuto. A folga faz o comportamento ser previsível.
    */
    backupCom(25);
    expect(jaHaBackupDeHoje(dir)).toBe(false);
  });

  it('cópia de dezenove horas: ainda conta como de hoje', () => {
    backupCom(19);
    expect(jaHaBackupDeHoje(dir)).toBe(true);
  });

  it('cópia de vinte e uma horas: já não conta', () => {
    backupCom(21);
    expect(jaHaBackupDeHoje(dir)).toBe(false);
  });

  it('cópia de MIGRAÇÃO não conta como diária', () => {
    /*
      Ela é tirada por outro motivo, num instante que ninguém escolheu, e some
      por outra régua de retenção. Deixá-la contar faria uma migração cancelar
      o diário daquele dia.
    */
    backupCom(1, 'pre-migracao-v73');
    expect(jaHaBackupDeHoje(dir)).toBe(false);
  });

  it('cópia da ROTAÇÃO DE CHAVE também não conta', () => {
    backupCom(1, 'pre-rotacao-de-chave');
    expect(jaHaBackupDeHoje(dir)).toBe(false);
  });

  it('pasta que não existe: não há', () => {
    expect(jaHaBackupDeHoje(join(dir, 'nao-existe'))).toBe(false);
  });

  it('entre várias, vale a mais recente', () => {
    backupCom(50);
    backupCom(30);
    backupCom(2);
    expect(jaHaBackupDeHoje(dir)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(3);
  });
});
