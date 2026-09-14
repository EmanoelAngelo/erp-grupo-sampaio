/**
 * Backup — o que está em dia e o que falhou (GAP-PRD-011, GAP-PRD-068).
 *
 * A rota de estado respondia `lastBackup: null` cravado e nenhuma tela
 * perguntava: a cópia remota podia falhar por meses sem ninguém saber, e o
 * único sinal era uma linha no log do servidor. Esta tela mostra, sem SQL nem
 * log, item por item:
 *
 *   PRONTO    conferido e em dia;
 *   PENDENTE  falta configurar (outro disco, cópia remota) ou ainda não houve
 *             a primeira vez;
 *   FALHOU    a última tentativa falhou (com o motivo), ou a última cópia boa
 *             é velha demais.
 *
 * "Conferir o bucket agora" pede ao servidor que leia o bucket e confira se o
 * último banco enviado e todas as fotos do último conjunto estão lá — enviar
 * não é o mesmo que estar lá. Nenhuma chave aparece: o servidor manda nomes
 * de arquivo e de objeto.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  conferirBucketDoBackup,
  consultarEstadoDoBackup,
  type EstadoDoBackup,
  type EstadoDoItemDeBackup,
  type ExecucaoDoBackup,
} from '@/lib/api/backup';
import { dataHoraBR } from '@/lib/datas';

const ESTADO: Record<EstadoDoItemDeBackup, { rotulo: string; tom: 'success' | 'warning' | 'danger'; ordem: number }> = {
  FALHOU: { rotulo: 'FALHOU', tom: 'danger', ordem: 0 },
  PENDENTE: { rotulo: 'PENDENTE', tom: 'warning', ordem: 1 },
  PRONTO: { rotulo: 'PRONTO', tom: 'success', ordem: 2 },
};

const VEREDITO: Record<EstadoDoItemDeBackup, string> = {
  FALHOU: 'O BACKUP TEM FALHA',
  PENDENTE: 'BACKUP INCOMPLETO',
  PRONTO: 'BACKUP EM DIA',
};

const GATILHO: Record<ExecucaoDoBackup['gatilho'], string> = {
  boot: 'ao subir',
  agenda: 'agendada',
  manual: 'manual',
};

function tamanho(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function resumoDaEtapa(e: ExecucaoDoBackup): { local: string; remoto: string; fotos: string } {
  const local = { ok: 'ok', falhou: 'falhou', pulado: 'pulada' }[e.local.estado];
  const remoto = {
    ok: 'subiu',
    falhou: 'falhou',
    nao_configurado: 'não configurada',
    nao_tentado: '—',
  }[e.remoto.estado];
  const fotos = {
    enviado: `${e.uploads.enviados ?? 0} nova(s)`,
    sem_mudanca: 'sem mudança',
    vazio: 'nenhuma foto',
    falhou: 'falhou',
    nao_configurado: 'não configurada',
    nao_tentado: '—',
  }[e.uploads.estado];
  return { local, remoto, fotos };
}

function motivoDaFalha(e: ExecucaoDoBackup): string {
  if (e.local.estado === 'falhou') return `Cópia local: ${e.local.detalhe ?? 'sem motivo'}`;
  if (e.remoto.estado === 'falhou') return `Envio ao bucket: ${e.remoto.detalhe ?? 'sem motivo'}`;
  return `Fotos: ${e.uploads.detalhe ?? 'sem motivo'}`;
}

export default function BackupPage() {
  const [estado, setEstado] = useState<EstadoDoBackup | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [conferindo, setConferindo] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setEstado(await consultarEstadoDoBackup());
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao consultar o estado do backup.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const conferirBucket = async () => {
    setConferindo(true);
    setAviso(null);
    try {
      const r = await conferirBucketDoBackup();
      setEstado(r.estado);
      setErro(null);
      setAviso(
        r.conferencia.ok
          ? `Bucket conferido: ${r.conferencia.bancos} cópia(s) do banco`
            + (r.conferencia.fotosNoManifesto !== null ? ` e ${r.conferencia.fotosNoManifesto} foto(s) do último conjunto` : '')
            + ', nada faltando.'
          : `A conferência achou problema: ${r.conferencia.motivo ?? 'sem motivo'}.`,
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao conferir o bucket.');
    } finally {
      setConferindo(false);
    }
  };

  // O que falhou vem primeiro: é o que a pessoa veio procurar.
  const itens = estado ? [...estado.itens].sort((a, b) => ESTADO[a.estado].ordem - ESTADO[b.estado].ordem) : [];
  const hora = estado ? `${String(estado.agenda.hora).padStart(2, '0')}:00` : '';

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Backup']}
        title="Backup"
        subtitle="A cópia do banco, a cópia fora deste computador e as fotos: o que está em dia e o que falhou."
        actions={
          <div className="flex flex-wrap gap-2">
            {estado?.remoto.configurado && (
              <Button variant="secondary" onClick={() => void conferirBucket()} disabled={conferindo}>
                {conferindo ? 'Conferindo o bucket…' : 'Conferir o bucket agora'}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void carregar()} disabled={carregando}>
              {carregando ? 'Atualizando…' : 'Atualizar'}
            </Button>
          </div>
        }
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      {aviso && (
        <div role="status" className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)] text-[var(--gs-info)]">
          {aviso}
        </div>
      )}

      {estado && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <Badge tone={ESTADO[estado.geral].tom}>{VEREDITO[estado.geral]}</Badge>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {estado.local.quantidade} cópia(s) na pasta, {tamanho(estado.local.bytes)} ·{' '}
                {estado.remoto.configurado ? `bucket "${estado.remoto.bucket}"` : 'sem cópia remota'}
              </span>
            </div>
            <p className="m-0 text-[length:var(--gs-text-sm)]">
              O diário roda ao subir a API e todo dia às {hora} (relógio da loja). Próxima: {dataHoraBR(estado.agenda.proxima)}.
            </p>
            <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Pasta do backup: <code>{estado.local.pasta}</code>
              {estado.local.ultimo && (
                <>
                  {' '}· última cópia: <code>{estado.local.ultimo.arquivo}</code> ({tamanho(estado.local.ultimo.bytes)}, {dataHoraBR(estado.local.ultimo.criadoEm)})
                </>
              )}
            </p>
          </Card>

          <ul className="list-none p-0 mt-5 mb-0 grid gap-3" aria-label="Itens do backup">
            {itens.map((item) => (
              <li key={item.id} data-testid={`item-${item.id}`}>
                <Card>
                  <div className="flex flex-wrap items-center gap-3 mb-1">
                    <Badge tone={ESTADO[item.estado].tom}>{ESTADO[item.estado].rotulo}</Badge>
                    <strong>{item.titulo}</strong>
                    {item.quando && (
                      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">{dataHoraBR(item.quando)}</span>
                    )}
                  </div>
                  <p className="m-0 text-[length:var(--gs-text-sm)]">{item.detalhe}</p>
                  {item.comoResolver && item.estado !== 'PRONTO' && (
                    <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      Como resolver: {item.comoResolver}
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>

          {estado.falhas.length > 0 && (
            <section className="mt-6" aria-label="Falhas dos últimos 30 dias">
              <h2 className="text-[length:var(--gs-text-lg)] font-semibold mb-2">Falhas dos últimos 30 dias</h2>
              <ul className="list-none p-0 m-0 grid gap-2">
                {estado.falhas.map((f) => (
                  <li key={f.id} className="text-[length:var(--gs-text-sm)]">
                    <strong>{dataHoraBR(f.iniciadoEm)}</strong> — {motivoDaFalha(f)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {estado.execucoes.length > 0 && (
            <section className="mt-6" aria-label="Últimas execuções do diário">
              <h2 className="text-[length:var(--gs-text-lg)] font-semibold mb-2">Últimas execuções</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-[length:var(--gs-text-sm)]">
                  <thead>
                    <tr className="text-left text-[var(--gs-muted)]">
                      <th className="py-1 pr-4 font-medium">Quando</th>
                      <th className="py-1 pr-4 font-medium">Como</th>
                      <th className="py-1 pr-4 font-medium">Cópia local</th>
                      <th className="py-1 pr-4 font-medium">Bucket</th>
                      <th className="py-1 font-medium">Fotos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {estado.execucoes.map((e) => {
                      const r = resumoDaEtapa(e);
                      return (
                        <tr key={e.id} className="border-t border-[var(--gs-border)]">
                          <td className="py-1 pr-4">{dataHoraBR(e.iniciadoEm)}</td>
                          <td className="py-1 pr-4">{GATILHO[e.gatilho]}</td>
                          <td className="py-1 pr-4">{r.local}{e.local.bytes ? ` (${tamanho(e.local.bytes)})` : ''}</td>
                          <td className="py-1 pr-4">{r.remoto}</td>
                          <td className="py-1">{r.fotos}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="mt-6 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Disco morto: a volta a partir do bucket é por comando, no servidor —{' '}
            <code>node server/dist/scripts/restaurar-do-bucket.js &lt;pasta-nova&gt;</code> traz o banco e as fotos mais
            novos, conferidos. O roteiro inteiro está em <code>docs/DEPLOY.md</code>, &quot;Disco morto&quot;.
          </p>
        </>
      )}
    </AppShell>
  );
}
