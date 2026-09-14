/**
 * A fila de e-mail transacional.
 *
 * POR QUE ELA É VISÍVEL
 *
 * Enquanto não houver SMTP, nada sai. "Pronto para a credencial" só é uma
 * afirmação verificável se der para LER, antes de ligar, exatamente o que
 * sairia — assunto e corpo, mensagem por mensagem. Uma caixa preta que promete
 * funcionar no dia da chave não é prontidão, é esperança.
 *
 * O QUE ELA NÃO MOSTRA, DE PROPÓSITO (GAP-PRD-007)
 *
 * O link de recuperação de senha e o código de verificação são do CLIENTE: o
 * servidor devolve o corpo com um marcador no lugar deles, e esta tela diz que
 * o conteúdo foi omitido. Antes, o gerente lia aqui o link e tomava a conta.
 *
 * O botão de enviar existe e é honesto: sem credencial ele responde
 * `READY_FOR_CREDENTIAL` e não muda nada. Não há modo "fingir que mandou" —
 * e-mail marcado como enviado sem ter saído faz o suporte procurar na caixa do
 * cliente uma mensagem que nunca chegou.
 *
 * A FALHA TEM MOTIVO E VOLTA (GAP-PRD-038)
 *
 * Cada mensagem mostra quantas tentativas fez, quando sai a próxima e POR QUE
 * falhou. A que desistiu ganha "Reenviar" — ou a explicação de por que não dá
 * (link vencido, anexo liberado) e o que fazer no lugar.
 *
 * CADA MENSAGEM COM O SEU NOME (GAP-PRD-199)
 *
 * O rótulo vem do SERVIDOR (`templateLabel`), tipado pela lista de modelos:
 * o mapa que morava aqui cobria 4 dos 9 e mostrava `recuperacao_senha` cru.
 *
 * A FILA DESTA EMPRESA, COM O REMETENTE DELA (GAP-PRD-198)
 *
 * "Processar fila" entrega só as mensagens da empresa em que o gerente está
 * logado (era a fila das seis). E o cartão do remetente é onde o dono escolhe
 * se esta empresa manda como o grupo ou como ela mesma.
 *
 * O QUE FALTA, NUM LUGAR SÓ (GAP-PRD-130)
 *
 * O cartão de prontidão lista o que ainda é configuração para esta empresa:
 * SMTP, destinatário e agenda do contador, usuário do contador, caixa de NF-e.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import { AppShell } from '@/components/gs/AppShell';
import { dataHoraBR } from '@/lib/datas';
import { RemetenteDaEmpresa } from '@/components/gs/RemetenteDaEmpresa';
import { ProntidaoDasComunicacoes } from '@/components/gs/ProntidaoDasComunicacoes';

interface Status {
  readiness: 'READY_FOR_CREDENTIAL' | 'READY';
  enabled: boolean;
  missing: string[];
  pending: number;
  sent: number;
  failed: number;
}

interface Mensagem {
  id: string;
  template: string;
  /** O nome do modelo em português, dado pelo servidor (GAP-PRD-199). */
  templateLabel?: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt?: string | null;
  sentAt: string | null;
  createdAt: string;
  podeReenviar?: boolean;
  motivoSemReenvio?: string | null;
}

type Filtro = 'todas' | 'pending' | 'sent' | 'failed';

const FILTROS: { valor: Filtro; rotulo: string }[] = [
  { valor: 'todas', rotulo: 'Todas' },
  { valor: 'pending', rotulo: 'Na fila' },
  { valor: 'sent', rotulo: 'Enviadas' },
  { valor: 'failed', rotulo: 'Com falha' },
];

const SITUACAO: Record<string, string> = {
  pending: 'Na fila',
  sent: 'Enviada',
  failed: 'Falhou',
};

/** O marcador que o servidor põe no lugar do link e do código do cliente. */
const MARCA_PROTEGIDA = '[protegido: só o cliente recebe]';

export default function EmailsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [itens, setItens] = useState<Mensagem[]>([]);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [aberta, setAberta] = useState<string | null>(null);
  const [reenviando, setReenviando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async (qual: Filtro) => {
    try {
      const caminho = qual === 'todas' ? '/core/emails' : `/core/emails?status=${qual}`;
      const r = await apiRequest<{ status: Status; items: Mensagem[] }>(caminho).then((r) =>
        exigirCampos(r, 'status', 'items'),
      );
      setStatus(r.status);
      setItens(r.items);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar a fila.');
    }
  }, []);

  useEffect(() => {
    void carregar(filtro);
  }, [carregar, filtro]);

  const enviar = async () => {
    setErro(null);
    setAviso(null);
    try {
      const r = await apiRequest<{ readiness: string; sent: number; missing: string[] }>(
        '/core/emails/enviar',
        { method: 'POST' },
      ).then((r) => exigirCampos(r, 'readiness', 'sent', 'missing'));
      setAviso(
        r.readiness === 'READY_FOR_CREDENTIAL'
          ? `Nada foi enviado: falta ${r.missing.join(', ')}. As mensagens seguem na fila.`
          : `${r.sent} mensagem(ns) enviada(s).`,
      );
      await carregar(filtro);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao processar a fila.');
    }
  };

  const reenviar = async (id: string) => {
    setErro(null);
    setAviso(null);
    setReenviando(id);
    try {
      await apiRequest<{ item: Mensagem }>(`/core/emails/${encodeURIComponent(id)}/reenviar`, {
        method: 'POST',
      }).then((r) => exigirCampos(r, 'item'));
      setAviso('Mensagem de volta à fila. Ela sai na próxima tentativa do carteiro.');
      await carregar(filtro);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível reenviar a mensagem.');
    } finally {
      setReenviando(null);
    }
  };

  return (
    <AppShell>
      <div className="p-6">
        <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] mt-0 mb-1">
          E-mails para o cliente
        </h1>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-6">
          As mensagens são montadas no instante do fato e guardadas prontas. Enquanto não houver
          servidor de e-mail configurado, elas ficam aqui — nenhuma se perde.
        </p>

        {erro && (
          <p role="alert" className="text-[var(--gs-danger)] mb-4">
            {erro}
          </p>
        )}
        {aviso && (
          <p role="status" className="text-[var(--gs-info)] mb-4">
            {aviso}
          </p>
        )}

        {status && (
          <div
            className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
              rounded-[var(--gs-radius-lg)] p-5 mb-6"
          >
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <strong className="text-[length:var(--gs-text-lg)]">
                {status.enabled ? 'Envio ligado' : 'Aguardando credencial'}
              </strong>
              <span
                className={`px-2 py-0.5 rounded-[var(--gs-radius)] text-[length:var(--gs-text-xs)]
                  font-semibold ${
                  status.enabled
                    ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
                    : 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
                  }`}
              >
                {status.readiness}
              </span>
            </div>

            <p className="text-[length:var(--gs-text-sm)] m-0 mb-3">
              {status.pending} na fila · {status.sent} enviada(s) · {status.failed} com falha
            </p>

            {status.missing.length > 0 && (
              <div className="text-[length:var(--gs-text-sm)]">
                {/* A lista é acionável: cada item é uma variável do .env. */}
                <span className="text-[var(--gs-muted)]">Falta configurar:</span>
                <ul className="mt-1 mb-0 pl-5">
                  {status.missing.map((m) => (
                    <li key={m} className="font-mono text-[length:var(--gs-text-xs)]">
                      {m}
                    </li>
                  ))}
                </ul>
                {/*
                  O RECADO QUE FALTAVA (GAP-PRD-065): o dono preenchia o .env e
                  a tela continuava dizendo que faltava — sem uma palavra sobre
                  reinício. Agora o servidor relê as variáveis EMAIL_* a cada
                  tentativa, e a tela diz isso, com a exceção honesta.
                */}
                <p className="mt-2 mb-0 text-[var(--gs-muted)]">
                  Preencha no arquivo <span className="font-mono">.env</span> do servidor. O
                  servidor relê essas variáveis a cada tentativa: depois de salvar,{' '}
                  <strong>não precisa reiniciar a API</strong> — clique em Processar fila. Só é
                  preciso reiniciar se a variável estiver definida no ambiente do sistema (fora do{' '}
                  <span className="font-mono">.env</span>).
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => void enviar()}
              className="mt-4 bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white
                border-0 rounded-[var(--gs-radius)] px-4 py-2 font-semibold cursor-pointer"
            >
              Processar fila
            </button>
            <p className="mt-2 mb-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Entrega as mensagens desta empresa. As das outras empresas seguem com o carteiro
              automático, que passa a cada minuto.
            </p>
          </div>
        )}

        <ProntidaoDasComunicacoes />

        <RemetenteDaEmpresa />

        <div role="group" aria-label="Filtrar por situação" className="flex flex-wrap gap-2 mb-4">
          {FILTROS.map((f) => (
            <button
              key={f.valor}
              type="button"
              aria-pressed={filtro === f.valor}
              onClick={() => setFiltro(f.valor)}
              className={`px-3 py-1 rounded-[var(--gs-radius)] text-[length:var(--gs-text-sm)]
                cursor-pointer border ${
                filtro === f.valor
                  ? 'bg-[var(--gs-purple-700)] text-white border-[var(--gs-purple-700)]'
                  : 'bg-[var(--gs-surface)] text-[var(--gs-purple-700)] border-[var(--gs-border)]'
                }`}
            >
              {f.rotulo}
            </button>
          ))}
        </div>

        {itens.length === 0 ? (
          <p className="text-[var(--gs-muted)]">
            {filtro === 'todas' ? 'Nenhuma mensagem na fila.' : 'Nenhuma mensagem nesta situação.'}
          </p>
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {itens.map((m) => (
              <li
                key={m.id}
                className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
                  rounded-[var(--gs-radius)] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <strong className="text-[length:var(--gs-text-sm)]">
                      {m.templateLabel ?? m.template}
                    </strong>
                    <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      Para {m.toAddress} · {new Date(m.createdAt).toLocaleString('pt-BR')}
                    </span>
                  </div>
                  <span
                    className={`text-[length:var(--gs-text-xs)] font-semibold ${
                      m.status === 'failed' ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-muted)]'
                    }`}
                  >
                    {SITUACAO[m.status] ?? m.status}
                  </span>
                </div>

                {/* As tentativas e a próxima hora: a fila explica a própria espera. */}
                {m.attempts > 0 && (
                  <p className="mt-1 mb-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    {m.attempts} tentativa(s)
                    {m.status === 'pending' && m.nextAttemptAt
                      ? ` · próxima tentativa em ${dataHoraBR(m.nextAttemptAt)}`
                      : ''}
                  </p>
                )}

                {/* O MOTIVO da falha, que a API já entregava e a tela escondia. */}
                {m.lastError && m.status !== 'sent' && (
                  <p className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                    Motivo: {m.lastError}
                  </p>
                )}

                {m.status === 'failed' && (
                  <div className="mt-2">
                    {m.podeReenviar ? (
                      <button
                        type="button"
                        disabled={reenviando === m.id}
                        onClick={() => void reenviar(m.id)}
                        className="bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white
                          border-0 rounded-[var(--gs-radius)] px-3 py-1 text-[length:var(--gs-text-sm)]
                          font-semibold cursor-pointer disabled:opacity-60"
                      >
                        {reenviando === m.id ? 'Reenviando…' : 'Reenviar'}
                      </button>
                    ) : (
                      m.motivoSemReenvio && (
                        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          Não dá para reenviar: {m.motivoSemReenvio}
                        </p>
                      )
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setAberta(aberta === m.id ? null : m.id)}
                  className="mt-2 bg-transparent border-0 p-0 text-[var(--gs-purple-700)]
                    cursor-pointer text-[length:var(--gs-text-sm)] underline"
                >
                  {aberta === m.id ? 'Fechar' : 'Ver a mensagem'}
                </button>

                {aberta === m.id && (
                  <div className="mt-2 border-t border-[var(--gs-border)] pt-2">
                    <p className="m-0 text-[length:var(--gs-text-sm)]">
                      <strong>Assunto:</strong> {m.subject}
                    </p>
                    {/* O corpo exato que sairia — é isso que torna a prontidão
                        conferível em vez de prometida. */}
                    <pre
                      className="mt-2 mb-0 whitespace-pre-wrap text-[length:var(--gs-text-sm)]
                        font-sans text-[var(--gs-muted)]"
                    >
                      {m.bodyText}
                    </pre>
                    {m.bodyText.includes(MARCA_PROTEGIDA) && (
                      <p className="mt-2 mb-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        O link ou código desta mensagem é de uso único e só o cliente recebe — por
                        isso ele não aparece aqui.
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
