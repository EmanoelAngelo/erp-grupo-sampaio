/**
 * Entrada de NF-e por e-mail.
 *
 * O fornecedor manda a nota para um endereço da empresa e o sistema busca
 * sozinho. É apenas outra porta para a mesma conferência do upload manual:
 * receber NÃO dá entrada no estoque — a nota entra em conferência e alguém
 * confirma, como sempre.
 *
 * A senha do e-mail é enviada uma vez e fica cifrada no cofre do backend. Esta
 * tela nunca a exibe de volta, nem depois de salva.
 *
 * A CAIXA NÃO ENTOPE (GAP-PRD-035). A leitura dizia "25 mensagem(ns), 0
 * nota(s)" para sempre com a 26ª invisível. Agora cada leitura diz quantas
 * AINDA RESTAM na caixa, e a empresa escolhe o que acontece com a mensagem
 * depois de lida: marcar como lida (padrão), mover para uma pasta ou não mexer.
 *
 * A SENHA RECUSADA TEM NOME (GAP-PRD-128). "Configurada" com a senha recusada
 * desde agosto era a tela da Preço Justo. A situação agora vem em português,
 * com o passo a passo da senha de aplicativo, e "Testar conexão" confere a
 * senha nova sem ler nenhuma nota.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type MailAfterRead,
  type MailCheckResult,
  type MailConnectionTest,
  type MailInboxStatus,
  type MailMessage,
  type MailSchedule,
} from '@/lib/api/core';

const OUTCOME_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  importado: 'success',
  frete: 'neutral',
  duplicado: 'neutral',
  sem_xml: 'neutral',
  invalido: 'danger',
  recusado: 'danger',
  ilegivel: 'warning',
};

const OUTCOME_LABEL: Record<string, string> = {
  importado: 'Em conferência',
  // CT-e não entra no funil de conferência — dizer 'Em conferência' para um
  // frete anunciaria uma nota que não existe na lista de entrada.
  frete: 'Frete (CT-e)',
  duplicado: 'Já importada',
  sem_xml: 'Sem NF-e',
  invalido: 'XML inválido',
  // NF-e legível que não pode entrar — a de homologação numa empresa em
  // produção (R3-DFE). O detalhe da mensagem diz qual anexo e por quê.
  recusado: 'Recusada',
  // Grande demais ou ilegível: registrada com o motivo, e a caixa segue (GAP-PRD-035).
  ilegivel: 'Não lida',
};

type Tom = 'neutral' | 'success' | 'warning' | 'danger';

/** A situação da caixa, em português (GAP-PRD-128). */
const SITUACAO: Record<MailInboxStatus['readiness'], { rotulo: string; tom: Tom }> = {
  READY_FOR_CREDENTIAL: { rotulo: 'Falta a senha de aplicativo', tom: 'neutral' },
  CONFIGURED: { rotulo: 'Configurada', tom: 'success' },
  CREDENTIAL_REJECTED: { rotulo: 'Senha recusada pelo provedor', tom: 'danger' },
  CONNECTION_FAILING: { rotulo: 'Última leitura falhou', tom: 'warning' },
};

const DEPOIS_DE_LER: Record<MailAfterRead, string> = {
  lida: 'Marcar como lida',
  mover: 'Mover para uma pasta',
  manter: 'Não mexer na caixa',
};

/** O aviso de "Ler agora", com o que ficou para a próxima (GAP-PRD-035). */
function resumoDaLeitura(r: MailCheckResult): string {
  const importadas = r.results.filter((m) => m.outcome === 'importado').length;
  const restantes = r.restantes ?? 0;
  const partes: string[] = [];
  if (r.checked === 0 && restantes === 0) {
    partes.push('Nenhuma mensagem nova.');
  } else {
    partes.push(`${r.checked} mensagem(ns) lida(s) · ${importadas} nota(s) em conferência.`);
  }
  if (restantes > 0) {
    partes.push(
      `Ainda há ${restantes} mensagem(ns) na caixa — clique em "Ler agora" de novo ou aguarde a leitura automática, que continua em 1 minuto.`,
    );
  }
  for (const aviso of r.avisos ?? []) partes.push(aviso);
  return partes.join(' ');
}

function dataHora(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}

export default function EntradaEmailPage() {
  const [status, setStatus] = useState<MailInboxStatus | null>(null);
  const [mensagens, setMensagens] = useState<MailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [lendo, setLendo] = useState(false);
  const [testando, setTestando] = useState(false);
  const [teste, setTeste] = useState<MailConnectionTest | null>(null);

  const carregar = useCallback(async () => {
    setError(null);
    try {
      setStatus(await coreApi.getMailInbox());
      setMensagens(await coreApi.listMailMessages());
    } catch (err) {
      setStatus(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao consultar a caixa.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const ler = useCallback(async () => {
    setLendo(true);
    setError(null);
    setAviso(null);
    setTeste(null);
    try {
      const r = await coreApi.checkMailInbox();
      await carregar();
      setAviso(resumoDaLeitura(r));
    } catch (err) {
      const motivo = err instanceof ApiRequestError ? err.message : 'Falha ao ler a caixa.';
      // A falha mudou a situação da caixa (senha recusada, pasta): recarrega.
      await carregar();
      setError(motivo);
    } finally {
      setLendo(false);
    }
  }, [carregar]);

  /** Entra, abre a pasta e sai — sem ler nenhuma nota (GAP-PRD-128). */
  const testar = useCallback(async () => {
    setTestando(true);
    setError(null);
    setAviso(null);
    setTeste(null);
    try {
      const r = await coreApi.testMailInbox();
      setTeste(r);
      setStatus(r.status);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao testar a conexão.');
    } finally {
      setTestando(false);
    }
  }, []);

  const situacao = status ? SITUACAO[status.readiness] ?? SITUACAO.CONFIGURED : null;
  const temSenha = Boolean(status?.inbox) && status?.readiness !== 'READY_FOR_CREDENTIAL';
  const pendentes = Number(status?.inbox?.imap_pending ?? 0);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Compras', 'NF-e por e-mail']}
        title="NF-e por e-mail"
        subtitle="O fornecedor manda a nota, o sistema busca. Receber não dá entrada: a nota entra em conferência."
        actions={
          status?.configured && (
            <Button loading={lendo} onClick={() => void ler()}>
              Ler agora
            </Button>
          )
        }
      />

      {aviso && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {aviso}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Caixa de entrada">
          {status === null ? (
            <p role="status" className="text-[var(--gs-muted)]">
              {error ? 'Não foi possível consultar.' : 'Carregando…'}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge tone={status.inbox ? situacao!.tom : 'neutral'}>
                  {status.inbox ? situacao!.rotulo.toUpperCase() : 'NÃO CONFIGURADA'}
                </Badge>
              </div>
              <p className="text-[length:var(--gs-text-base)]">{status.message}</p>

              {status.inbox && (
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Info rotulo="Endereço" valor={status.inbox.address} />
                  <Info rotulo="Servidor" valor={`${status.inbox.host}:${status.inbox.port}`} />
                  <Info rotulo="Pasta" valor={status.inbox.folder} />
                  <Info rotulo="Última leitura" valor={dataHora(status.inbox.last_check_at)} />
                  <Info
                    rotulo="Depois de ler"
                    valor={
                      status.inbox.after_read === 'mover'
                        ? `Mover para "${status.inbox.processed_folder ?? '—'}"`
                        : DEPOIS_DE_LER[status.inbox.after_read ?? 'lida']
                    }
                  />
                  <Info
                    rotulo="Aguardando leitura"
                    valor={pendentes > 0 ? `${pendentes} mensagem(ns)` : 'Nenhuma'}
                  />
                </dl>
              )}

              {status.inbox?.last_error && (
                <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
                  Último erro: {status.inbox.last_error}
                </p>
              )}

              {teste && (
                <p
                  role={teste.ok ? 'status' : 'alert'}
                  className={`px-3 py-2 rounded-[var(--gs-radius)] text-[length:var(--gs-text-sm)] ${
                    teste.ok
                      ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
                      : 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
                  }`}
                >
                  {teste.ok ? teste.message : `Conexão recusada: ${teste.message}`}
                </p>
              )}

              {temSenha && (
                <div>
                  <Button variant="ghost" loading={testando} onClick={() => void testar()}>
                    Testar conexão
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>

        <AgendamentoCard status={status} onSaved={carregar} />
      </div>

      <div className="mt-6">
        <ConfiguracaoCard status={status} onSaved={carregar} />
      </div>

      <div className="mt-6">
        <Card
          title="Mensagens recebidas"
          subtitle="Cada nota importada aparece em Compras › Entrada de notas para conferir e confirmar."
          padded={false}
        >
          {mensagens.length === 0 ? (
            <div className="px-6 py-5">
              <EmptyState
                title="Nenhuma mensagem"
                description="Quando o fornecedor enviar uma NF-e para o endereço configurado, ela aparece aqui."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className="py-2.5 px-4 font-semibold">Recebida</th>
                    <th className="py-2.5 px-4 font-semibold">De</th>
                    <th className="py-2.5 px-4 font-semibold">Assunto</th>
                    <th className="py-2.5 px-4 font-semibold">Situação</th>
                    <th className="py-2.5 px-4 font-semibold">Detalhe</th>
                  </tr>
                </thead>
                <tbody>
                  {mensagens.map((m) => (
                    <tr key={m.id} className="border-b border-[var(--gs-border)] last:border-0">
                      <td className="py-3 px-4 whitespace-nowrap">{dataHora(m.received_at)}</td>
                      <td className="py-3 px-4">{m.sender ?? '—'}</td>
                      <td className="py-3 px-4">{m.subject ?? '—'}</td>
                      <td className="py-3 px-4">
                        <Badge tone={OUTCOME_TONE[m.outcome] ?? 'neutral'}>
                          {OUTCOME_LABEL[m.outcome] ?? m.outcome}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-[var(--gs-text-soft)]">{m.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

function Info({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] px-4 py-3">
      <dt className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)]">
        {rotulo}
      </dt>
      <dd className="font-bold text-[var(--gs-purple-900)] break-words">{valor}</dd>
    </div>
  );
}

/**
 * Leitura automática.
 *
 * Roda no servidor, num laço próprio: o gestor liga uma vez e as notas passam
 * a entrar mesmo com o navegador fechado. "Ler agora" continua existindo para
 * quem não quer esperar o próximo ciclo.
 */
function AgendamentoCard({
  status,
  onSaved,
}: {
  status: MailInboxStatus | null;
  onSaved: () => void;
}) {
  const [schedule, setSchedule] = useState<MailSchedule | null>(null);
  const [intervalo, setIntervalo] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const s = await coreApi.getMailSchedule();
      setSchedule(s);
      if (s) setIntervalo(String(s.intervalMinutes));
    } catch {
      setSchedule(null);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar, status]);

  const alternar = useCallback(
    async (ligar: boolean) => {
      setBusy(true);
      setError(null);
      try {
        setSchedule(await coreApi.setMailSchedule(ligar, Number(intervalo) || 5));
        onSaved();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
      } finally {
        setBusy(false);
      }
    },
    [intervalo, onSaved],
  );

  const lendoAgora =
    schedule?.lockedUntil !== null &&
    schedule?.lockedUntil !== undefined &&
    new Date(schedule.lockedUntil).getTime() > Date.now();

  return (
    <Card
      title="Leitura automática"
      subtitle="Roda no servidor. As notas entram mesmo com o navegador fechado."
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge tone={schedule?.autoEnabled ? 'success' : 'neutral'}>
            {schedule?.autoEnabled ? 'ATIVA' : 'INATIVA'}
          </Badge>
          {lendoAgora && <Badge tone="warning">LENDO AGORA</Badge>}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Verificar a cada
          </span>
          <select
            value={intervalo}
            onChange={(e) => setIntervalo(e.target.value)}
            className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
              text-[length:var(--gs-text-base)]"
          >
            <option value="5">5 minutos</option>
            <option value="15">15 minutos</option>
            <option value="30">30 minutos</option>
            <option value="60">1 hora</option>
            <option value="240">4 horas</option>
          </select>
        </label>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Info rotulo="Última leitura" valor={dataHora(schedule?.lastRunAt ?? null)} />
          <Info
            rotulo="Próxima leitura"
            valor={schedule?.autoEnabled ? dataHora(schedule?.nextRunAt ?? null) : '—'}
          />
        </dl>

        {schedule?.lastResult && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Último resultado: {schedule.lastResult}
          </p>
        )}

        {/* Só o erro DA LEITURA AUTOMÁTICA aparece aqui — `lastErrorAt` é o
            que distingue. O campo de erro é compartilhado com o "Ler agora",
            e sem essa checagem o card mostrava uma falha manual antiga com a
            data em branco, parecendo defeito do agendador.
            Erro não desliga o agendamento: provedor fora do ar costuma ser
            temporário, e desligar sozinho faria as notas pararem de entrar sem
            ninguém perceber. */}
        {schedule?.lastError && schedule?.lastErrorAt && (
          <p
            role="alert"
            className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
          >
            Último erro ({dataHora(schedule.lastErrorAt)}): {schedule.lastError}
          </p>
        )}

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          {schedule?.autoEnabled ? (
            <Button variant="ghost" loading={busy} onClick={() => void alternar(false)}>
              Desativar
            </Button>
          ) : (
            <Button
              loading={busy}
              disabled={!status?.configured}
              onClick={() => void alternar(true)}
            >
              Ativar
            </Button>
          )}
          {schedule?.autoEnabled && (
            <Button variant="ghost" loading={busy} onClick={() => void alternar(true)}>
              Salvar intervalo
            </Button>
          )}
        </div>

        {!status?.configured && (
          <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
            Configure a caixa e a senha de aplicativo abaixo para poder ativar.
          </p>
        )}
        {status?.readiness === 'CREDENTIAL_REJECTED' && (
          <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">
            Com a senha recusada, cada leitura automática falha. Troque a senha e use "Testar
            conexão" antes de ativar.
          </p>
        )}
      </div>
    </Card>
  );
}

function ConfiguracaoCard({
  status,
  onSaved,
}: {
  status: MailInboxStatus | null;
  onSaved: () => void;
}) {
  const [address, setAddress] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState('INBOX');
  const [depoisDeLer, setDepoisDeLer] = useState<MailAfterRead>('lida');
  const [pastaDestino, setPastaDestino] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status?.inbox) {
      setAddress(status.inbox.address);
      setHost(status.inbox.host);
      setPort(String(status.inbox.port));
      setFolder(status.inbox.folder);
      setDepoisDeLer(status.inbox.after_read ?? 'lida');
      setPastaDestino(status.inbox.processed_folder ?? '');
    }
  }, [status]);

  // A senha não sobrevive à saída da tela.
  useEffect(() => () => setPassword(''), []);

  const salvar = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await coreApi.saveMailInbox({
        address,
        host,
        port: Number(port) || 993,
        folder,
        // Em branco = manter a senha atual. Salvar sem redigitar não pode
        // apagar a credencial que já funciona.
        password: password || undefined,
        afterRead: depoisDeLer,
        processedFolder: depoisDeLer === 'mover' ? pastaDestino : null,
      });
      setPassword('');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setBusy(false);
    }
  }, [address, host, port, folder, password, depoisDeLer, pastaDestino, onSaved]);

  return (
    <Card
      title={status?.inbox ? 'Alterar caixa' : 'Configurar caixa'}
      subtitle="A senha é enviada uma vez e fica cifrada no servidor. Esta tela nunca a mostra de volta."
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            E-mail que recebe as notas
          </span>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="notas@suaempresa.com.br"
          />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="flex flex-col gap-1.5 col-span-2">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Servidor IMAP
            </span>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="imap.gmail.com"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Porta
            </span>
            <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Senha de aplicativo
          </span>
          <Input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={status?.configured ? 'Deixe em branco para manter a atual' : ''}
          />
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            Gmail, Outlook e afins exigem uma senha de aplicativo — a senha normal da conta não
            funciona para IMAP. No Gmail: ative a verificação em duas etapas, gere a senha em Conta
            Google › Segurança › Senhas de app e confira que o IMAP está ativado nas
            configurações. Depois de salvar, use "Testar conexão".
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Pasta
          </span>
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Depois de ler cada mensagem
          </span>
          <select
            aria-label="Depois de ler cada mensagem"
            value={depoisDeLer}
            onChange={(e) => setDepoisDeLer(e.target.value as MailAfterRead)}
            className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white
              text-[length:var(--gs-text-base)]"
          >
            <option value="lida">Marcar como lida (recomendado)</option>
            <option value="mover">Mover para uma pasta</option>
            <option value="manter">Não mexer na caixa</option>
          </select>
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            Em qualquer opção, o sistema lembra onde parou: cada mensagem é lida uma vez, mesmo que
            alguém já a tenha aberto. "Não mexer" serve para a caixa que também é lida por gente.
          </span>
        </label>

        {depoisDeLer === 'mover' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Pasta das mensagens lidas
            </span>
            <Input
              value={pastaDestino}
              onChange={(e) => setPastaDestino(e.target.value)}
              placeholder="Notas processadas"
            />
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Criada na primeira leitura, se ainda não existir.
            </span>
          </label>
        )}

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}

        <Button loading={busy} disabled={!address || !host} onClick={() => void salvar()}>
          Salvar
        </Button>
      </div>
    </Card>
  );
}
