/**
 * O token do Melhor Envio, colado pelo gestor (GAP-PRD-117).
 *
 * NÃO EXISTIA TELA. A rota do servidor estava pronta e testada, e o único
 * jeito de entregar o insumo era chamar o desenvolvedor com curl e JWT — o
 * contrário do que o Asaas já fazia. Aqui o gestor escolhe o ambiente, cola o
 * token, testa, e vê na hora o que ainda trava a cotação no checkout.
 *
 * O TOKEN NÃO VOLTA. A resposta do servidor traz só a dica mascarada
 * (`••••1234`); o campo é de senha, sem autocompletar, e é limpo depois de
 * guardar. Trocar o token é colar outro por cima.
 *
 * AS TRAVAS VÊM PELO NOME. Quando a cotação não vale no checkout, a tela diz
 * por quê — inclusive quando o motivo é a chave do servidor
 * (`LOGISTICS_PRODUCTION_ENABLED`), que o gestor não liga mas precisa saber
 * que existe para pedir a quem liga.
 */
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Field, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import type { LogisticsCarrierStatus } from '@/lib/api/core';
import {
  logisticaApi,
  type AmbienteDaCredencial,
  type LogisticsAccessLock,
} from '@/lib/api/logistica';

/** A tradução dos códigos de trava que o servidor devolve. */
const TRAVA_DA_LOGISTICA: Record<LogisticsAccessLock, string> = {
  SEM_CREDENCIAL: 'Falta o token do Melhor Envio desta operação.',
  CREDENCIAL_DE_SANDBOX:
    'O token guardado é de SANDBOX: a cotação é real, mas de ambiente de teste — serve para '
    + 'conferir e não aparece no checkout.',
  PRODUCAO_DESABILITADA_NO_PROCESSO:
    'O servidor está com a produção de logística desligada (LOGISTICS_PRODUCTION_ENABLED). '
    + 'O token já está guardado; quem administra o servidor liga essa chave.',
  SANDBOX_EM_SERVIDOR_DE_PRODUCAO: 'Este servidor é de produção e não usa token de sandbox.',
  SEM_INTEGRACAO_DIRETA: 'Sem integração direta: a cotação sai simulada.',
  SIMULACAO_EM_SERVIDOR_DE_PRODUCAO: 'Simulação não opera em servidor de produção.',
};

const TOKEN_MINIMO = 10;

function mensagemDe(err: unknown, padrao: string): string {
  return err instanceof ApiRequestError ? err.message : padrao;
}

export function CredencialMelhorEnvio({
  status,
  onMudou,
}: {
  /** O estado do Melhor Envio vindo de `getLogisticsCarriers`. */
  status: LogisticsCarrierStatus | undefined;
  /** Recarregar prontidão e tabela depois de guardar, testar ou remover. */
  onMudou: () => void;
}) {
  const guardado = Boolean(status?.configured);
  const ambienteGuardado: AmbienteDaCredencial =
    status?.environment === 'production' ? 'production' : 'homologation';

  const [ambiente, setAmbiente] = useState<AmbienteDaCredencial>(ambienteGuardado);
  const [token, setToken] = useState('');
  const [email, setEmail] = useState(status?.contactEmail ?? '');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);

  // Quando o estado do servidor chega (ou muda), o formulário parte dele. Na
  // montagem os `useState` acima já partiram dele: repetir no efeito da
  // montagem corria contra o primeiro clique/digitação e o desfazia.
  const estadoAplicado = useRef(`${ambienteGuardado}|${status?.contactEmail ?? ''}`);
  useEffect(() => {
    const chave = `${ambienteGuardado}|${status?.contactEmail ?? ''}`;
    if (estadoAplicado.current === chave) return;
    estadoAplicado.current = chave;
    setAmbiente(ambienteGuardado);
    setEmail(status?.contactEmail ?? '');
  }, [ambienteGuardado, status?.contactEmail]);

  /**
   * Roda a ação e recarrega a tela — também na falha: o teste que falhou fica
   * guardado no servidor, e a coluna Conexão precisa mostrar isso.
   */
  const executar = async (acao: () => Promise<{ ok: boolean; mensagem: string }>, padrao: string) => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await acao();
      if (r.ok) setAviso(r.mensagem);
      else setErro(r.mensagem);
    } catch (err) {
      setErro(mensagemDe(err, padrao));
    } finally {
      setOcupado(false);
      onMudou();
    }
  };

  const guardar = () =>
    executar(async () => {
      const salvo = await logisticaApi.salvarCredencial({
        carrier: 'melhor_envio',
        environment: ambiente,
        token: token.trim(),
        contactEmail: email.trim() || undefined,
      });
      setToken('');
      const nome = salvo.environment === 'production' ? 'produção' : 'sandbox';
      return {
        ok: true,
        mensagem: `Token de ${nome} guardado${salvo.maskedHint ? ` (${salvo.maskedHint})` : ''}. `
          + 'Teste a conexão para confirmar que ele abre a conta.',
      };
    }, 'Não foi possível guardar o token.');

  const testar = () =>
    executar(async () => {
      const r = await logisticaApi.testarConexao('melhor_envio');
      return {
        ok: r.ok,
        mensagem: r.message ?? (r.ok ? 'Conexão OK.' : 'O teste de conexão falhou.'),
      };
    }, 'Não foi possível testar a conexão.');

  const remover = () =>
    executar(async () => {
      setConfirmandoRemocao(false);
      await logisticaApi.removerCredencial('melhor_envio');
      return { ok: true, mensagem: 'Token removido. O checkout deixou de cotar pelo Melhor Envio.' };
    }, 'Não foi possível remover o token.');

  const travas = (status?.access?.locks ?? []).filter((t) => guardado || t !== 'SEM_CREDENCIAL');
  const valendo = Boolean(status?.access?.chargeable);

  return (
    <Card
      title="Credencial do Melhor Envio"
      subtitle="Um token só cota Correios, Jadlog e as demais transportadoras do Melhor Envio. Ele vai para o cofre desta operação e não volta para a tela."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={guardado ? 'success' : 'neutral'}>
            {guardado ? `Guardado (${status?.maskedHint ?? 'oculto'})` : 'Nenhum token guardado'}
          </Badge>
          {guardado && (
            <Badge tone={ambienteGuardado === 'production' ? 'info' : 'warning'}>
              {ambienteGuardado === 'production' ? 'Token de produção' : 'Token de sandbox'}
            </Badge>
          )}
          {guardado && status?.connection?.tested && status.connection.message && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Último teste: {status.connection.message}
            </span>
          )}
        </div>

        {valendo ? (
          <p
            className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-success)]"
          >
            A cotação de produção vale como preço de frete no checkout.
          </p>
        ) : (
          travas.length > 0 && (
            <ul className="list-none p-0 m-0 flex flex-col gap-2">
              {travas.map((t) => (
                <li
                  key={t}
                  className="flex gap-2 items-start text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]"
                >
                  <span aria-hidden className="text-[var(--gs-warning)]">
                    ●
                  </span>
                  <span>{TRAVA_DA_LOGISTICA[t] ?? t}</span>
                </li>
              ))}
            </ul>
          )
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Ambiente do token"
            hint="Sandbox confere a integração; só o de produção vira preço cobrado do cliente."
          >
            {(p) => (
              <select
                {...p}
                value={ambiente}
                onChange={(e) => setAmbiente(e.target.value as AmbienteDaCredencial)}
                className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]"
              >
                <option value="homologation">Sandbox — teste</option>
                <option value="production">Produção — cobra do cliente</option>
              </select>
            )}
          </Field>
          <Field
            label="Token do Melhor Envio"
            hint="Gerado no painel do Melhor Envio, em Integrações → Permissões de acesso."
          >
            {(p) => (
              <Input
                {...p}
                // Campo de senha: o token não fica legível na tela nem no
                // histórico de formulário do navegador.
                type="password"
                autoComplete="off"
                value={token}
                placeholder={guardado ? 'Colar para substituir o atual' : 'Colar o token'}
                onChange={(e) => setToken(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="E-mail de contato técnico"
            hint="Opcional. O Melhor Envio pede que a integração se identifique; vai no cabeçalho das chamadas."
          >
            {(p) => (
              <Input
                {...p}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button disabled={ocupado || token.trim().length < TOKEN_MINIMO} onClick={() => void guardar()}>
            Guardar token
          </Button>
          {guardado && (
            <Button variant="secondary" loading={ocupado} onClick={() => void testar()}>
              Testar conexão
            </Button>
          )}
          {guardado && !confirmandoRemocao && (
            <Button variant="ghost" disabled={ocupado} onClick={() => setConfirmandoRemocao(true)}>
              Remover token
            </Button>
          )}
        </div>

        {/* A pergunta é um bloco na tela, e não um `confirm()` do navegador:
            o que precisa ser lido é a consequência, e ela cabe aqui. */}
        {confirmandoRemocao && (
          <div
            className="px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)]
              bg-[var(--gs-warning-bg)] flex flex-col gap-3"
          >
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text)]">
              Tirar o token? A partir de agora o checkout deixa de cotar pelo Melhor Envio e cai
              na tabela da loja (ou só retirada).
            </span>
            <div className="flex gap-3">
              <Button variant="danger" disabled={ocupado} onClick={() => void remover()}>
                Sim, remover
              </Button>
              <Button variant="ghost" disabled={ocupado} onClick={() => setConfirmandoRemocao(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {aviso && (
          <p
            role="status"
            className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-success)]"
          >
            {aviso}
          </p>
        )}
        {erro && (
          <p
            role="alert"
            className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
          >
            {erro}
          </p>
        )}
      </div>
    </Card>
  );
}
