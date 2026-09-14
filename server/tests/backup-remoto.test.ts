/**
 * CÓPIA REMOTA DO BANCO — Supabase Storage.
 *
 * A rodada 35 tirou o backup da pasta do banco, mas ele continuou no MESMO
 * computador: o log avisa isso a cada boot desde então. A cópia remota é a
 * proteção que falta — disco morre, PC é furtado, a loja pega fogo: o banco
 * de ontem está fora do prédio.
 *
 * A divisão de responsabilidade é a mesma do Asaas: a CONTA e a CHAVE são do
 * dono e moram no arquivo de ambiente (DEVORA_SUPABASE_URL,
 * DEVORA_SUPABASE_SERVICE_KEY, DEVORA_SUPABASE_BUCKET) — nunca no chat,
 * nunca no banco, nunca no log. O código sobe o arquivo do diário para o
 * bucket, e é só isso que ele faz.
 *
 * ## As regras que este arquivo trava
 *
 *   - o envio é MELHOR ESFORÇO: falha remota NUNCA derruba o diário local —
 *     um backup em casa é melhor que nenhum;
 *   - a CHAVE não aparece em motivo de falha nem em log (provado vasculhando
 *     o texto);
 *   - sem configuração, o resultado DIZ que não está configurado — e o
 *     diário avisa, porque silêncio aqui é o dono achando que tem cópia
 *     remota quando não tem.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { enviarBackupRemoto, executarBackupDiarioComRemoto } from '../src/db/backupRemoto.js';

const CONFIG = {
  url: 'https://abc123.supabase.co',
  serviceKey: 'chave-servico-super-secreta',
  bucket: 'backups',
};

function arquivoDeBackup(conteudo = 'sqlite-fake-bytes'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-backup-'));
  const caminho = join(dir, 'grupo-sampaio-2026-08-24-diario.db');
  writeFileSync(caminho, conteudo);
  return caminho;
}

describe('o envio para o bucket', () => {
  it('sobe o arquivo com upsert para o caminho certo, autenticado — e nada além disso', async () => {
    const caminho = arquivoDeBackup('bytes-do-banco');
    const chamadas: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      chamadas.push({ url: String(url), init: init ?? {} });
      return new Response('{"Key":"ok"}', { status: 200 });
    }) as typeof fetch;

    const r = await enviarBackupRemoto(caminho, { fetchImpl, config: CONFIG });
    expect(r.ok).toBe(true);

    expect(chamadas).toHaveLength(1);
    const { url, init } = chamadas[0];
    expect(url).toBe(
      'https://abc123.supabase.co/storage/v1/object/backups/grupo-sampaio-2026-08-24-diario.db',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${CONFIG.serviceKey}`);
    // As chaves novas (sb_secret_...) autenticam pelo apikey; as antigas
    // pelo Bearer. Os DOIS viajam.
    expect(headers.apikey).toBe(CONFIG.serviceKey);
    // Reenviar o diário do mesmo dia SUBSTITUI — não acumula duplicata.
    expect(headers['x-upsert']).toBe('true');
    expect(Buffer.from(init.body as ArrayBuffer).toString()).toBe('bytes-do-banco');
  });

  it('sem configuração, diz que não está configurado — sem tocar a rede', async () => {
    const caminho = arquivoDeBackup();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await enviarBackupRemoto(caminho, {
      fetchImpl,
      config: { url: '', serviceKey: '', bucket: '' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/configur/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('recusa do bucket vira motivo legível — e a CHAVE não vaza no texto', async () => {
    const caminho = arquivoDeBackup();
    const fetchImpl = (async () =>
      new Response('{"error":"Access denied"}', { status: 403 })) as typeof fetch;
    const r = await enviarBackupRemoto(caminho, { fetchImpl, config: CONFIG });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivo).toMatch(/403/);
      expect(r.motivo).not.toContain(CONFIG.serviceKey);
    }
  });

  it('queda de rede NÃO lança — melhor esforço é promessa que resolve', async () => {
    const caminho = arquivoDeBackup();
    const fetchImpl = (async () => {
      throw new Error('rede caiu');
    }) as typeof fetch;
    const r = await enviarBackupRemoto(caminho, { fetchImpl, config: CONFIG });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/rede caiu/);
  });
});

describe('o diário com a cópia remota', () => {
  it('o arquivo que o diário acabou de criar é o que sobe — mesmo nome, mesma versão', async () => {
    const enviados: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      enviados.push(String(url));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const r = await executarBackupDiarioComRemoto({ fetchImpl, config: CONFIG });
    // O diário local aconteceu (ou foi pulado por banco :memory:, e aí o
    // remoto também não tem o que subir).
    if (r.local.skipped) {
      expect(enviados).toHaveLength(0);
      return;
    }
    expect(enviados).toHaveLength(1);
    const nome = r.local.path.split(/[\\/]/).pop()!;
    expect(enviados[0].endsWith(`/backups/${nome}`)).toBe(true);
    expect(r.remoto?.ok).toBe(true);
  });

  it('falha remota não derruba o diário: o local fica de pé e o motivo fica registrado', async () => {
    const fetchImpl = (async () => {
      throw new Error('bucket fora do ar');
    }) as typeof fetch;
    const r = await executarBackupDiarioComRemoto({ fetchImpl, config: CONFIG });
    if (r.local.skipped) return;
    expect(r.local.path).toBeTruthy();
    expect(r.remoto?.ok).toBe(false);
  });
});
