/**
 * Configurações › Entrar com Google (loja) — GAP-PRD-027.
 *
 * A tela onde o dono põe o cliente OAuth que criou no Google Cloud Console.
 * Com os três campos (Client ID, segredo, endereço de retorno) e "Ligado",
 * o botão "Entrar com Google" aparece na tela de entrar da loja — sem uma
 * linha de código.
 *
 * O segredo entra e não volta: o campo é de senha, esvazia depois de salvar,
 * e a tela mostra só a dica (••••abcd). Em branco, salvar mantém o guardado.
 *
 * O PROVEDOR DE TESTE aparece como opção só quando o servidor diz que este
 * ambiente o permite (nunca em produção). Ele simula o Google para ensaio.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { dataHoraBR } from '@/lib/datas';
import {
  googleConfigApi,
  type ConfiguracaoDoGoogle,
  type EstadoDaProntidao,
  type ModoDoGoogle,
} from '@/lib/api/loginGoogle';

const SELO: Record<EstadoDaProntidao, { tom: 'success' | 'info' | 'warning' | 'danger'; texto: string }> = {
  pronto: { tom: 'success', texto: 'Ligado — Google' },
  pronto_teste: { tom: 'info', texto: 'Ligado — provedor de teste' },
  desligado: { tom: 'warning', texto: 'Desligado' },
  bloqueado: { tom: 'danger', texto: 'Bloqueado neste ambiente' },
};

/**
 * Resposta sem o formato combinado (proxy que engoliu o corpo, versão
 * diferente do servidor) vira erro com voz — nunca a tela em branco.
 */
function conferida(c: ConfiguracaoDoGoogle): ConfiguracaoDoGoogle {
  if (!c || typeof c !== 'object' || !c.prontidao || !Array.isArray(c.prontidao.falta)) {
    throw new Error('O servidor respondeu sem a configuração do Google. Recarregue a página.');
  }
  return c;
}

export default function LoginGooglePage() {
  const [cfg, setCfg] = useState<ConfiguracaoDoGoogle | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    providerMode: 'google' as ModoDoGoogle,
    clientId: '',
    clientSecret: '',
    redirectUri: '',
  });
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const aplicar = (c: ConfiguracaoDoGoogle) => {
    setCfg(c);
    setForm({
      enabled: c.enabled,
      providerMode: c.providerMode,
      clientId: c.clientId ?? '',
      clientSecret: '',
      redirectUri: c.redirectUri ?? c.redirectUriSugerido,
    });
  };

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      aplicar(conferida(await googleConfigApi.obter()));
    } catch (err) {
      setErro(
        err instanceof ApiRequestError || err instanceof Error
          ? err.message
          : 'Não foi possível ler a configuração do Google.',
      );
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = async () => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const c = conferida(await googleConfigApi.salvar(form));
      aplicar(c);
      setAviso(c.enabled ? 'Salvo. O botão "Entrar com Google" já aparece na loja.' : 'Salvo. A loja não mostra o botão enquanto estiver desligado.');
    } catch (err) {
      setErro(err instanceof ApiRequestError || err instanceof Error ? err.message : 'Não foi possível salvar.');
    } finally {
      setOcupado(false);
    }
  };

  const selo = cfg ? SELO[cfg.prontidao.estado] : null;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Entrar com Google (loja)']}
        title="Entrar com Google na loja online"
        subtitle="O cliente da loja entra ou cria a conta com a conta Google dele. Vale para todas as lojas do grupo."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)] mt-0">
          {erro}
        </p>
      )}

      {cfg && selo && (
        <Card
          title="Situação"
          subtitle={cfg.prontidao.mensagem}
          actions={<Badge tone={selo.tom}>{selo.texto}</Badge>}
          className="mb-5"
        >
          {cfg.prontidao.falta.length > 0 ? (
            <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)]" aria-label="O que falta">
              {cfg.prontidao.falta.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Nada falta.{cfg.updatedAt ? ` Última alteração em ${dataHoraBR(cfg.updatedAt)}.` : ''}
            </p>
          )}
        </Card>
      )}

      {cfg && (
        <Card
          title="Cliente OAuth"
          subtitle="Criado no Google Cloud Console (APIs e serviços › Credenciais › ID do cliente OAuth, tipo Aplicativo da Web)."
          className="mb-5"
        >
          <div className="grid grid-cols-1 gap-4 max-w-2xl">
            {cfg.provedorDeTestePermitido && (
              <fieldset className="border-0 p-0 m-0 flex flex-col gap-2">
                <legend className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)] mb-1">
                  Provedor
                </legend>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="provedor-google"
                    checked={form.providerMode === 'google'}
                    onChange={() => setForm({ ...form, providerMode: 'google' })}
                  />
                  Google (o de verdade)
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="provedor-google"
                    checked={form.providerMode === 'teste'}
                    onChange={() => setForm({ ...form, providerMode: 'teste' })}
                  />
                  Provedor de teste (ensaio sem Google — o servidor recusa em produção)
                </label>
              </fieldset>
            )}

            <Field
              label="Client ID"
              hint={form.providerMode === 'google' ? 'Termina em .apps.googleusercontent.com' : 'Qualquer identificador de ensaio.'}
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                  placeholder="123456789-abc.apps.googleusercontent.com"
                  autoComplete="off"
                />
              )}
            </Field>

            <Field
              label="Segredo do cliente"
              hint={
                cfg.secretConfigured
                  ? `Guardado (${cfg.secretHint ?? '••••'}). Deixe em branco para manter; digite para trocar.`
                  : 'Fica selado no cofre do servidor e nunca volta para esta tela.'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  value={form.clientSecret}
                  onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                  autoComplete="new-password"
                />
              )}
            </Field>

            <Field
              label="Endereço de retorno (redirect URI)"
              hint={`Cadastre exatamente este endereço no Google, em "URIs de redirecionamento autorizados". Sugerido: ${cfg.redirectUriSugerido}`}
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.redirectUri}
                  onChange={(e) => setForm({ ...form, redirectUri: e.target.value })}
                  autoComplete="off"
                />
              )}
            </Field>
            {!cfg.enderecoPublicoConfigurado && (
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                O endereço público da loja (GRUPO_SAMPAIO_PUBLIC_URL) não está declarado no servidor: a
                sugestão acima usa o endereço de reserva. Confira antes de cadastrar no Google.
              </p>
            )}

            <label className="flex items-center gap-2 cursor-pointer font-semibold">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Ligado — mostrar "Entrar com Google" na loja
            </label>
          </div>

          <Button onClick={() => void salvar()} loading={ocupado} className="mt-4">
            Salvar
          </Button>
          {aviso && (
            <p role="status" className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)] mb-0">
              {aviso}
            </p>
          )}
        </Card>
      )}

      <Card title="Como fica para o cliente" subtitle="O que o sistema faz com a identidade que o Google devolve.">
        <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)] flex flex-col gap-1">
          <li>Só entra e-mail que o Google diz verificado.</li>
          <li>Se já existe conta com o mesmo e-mail, o Google se liga a ela e o dono do e-mail recebe um aviso.</li>
          <li>Se não existe, a conta nasce sem senha, com o e-mail já confirmado, depois do aceite dos termos.</li>
          <li>Nenhuma senha nem token do Google é guardado — só quem é a pessoa (o identificador do Google).</li>
          <li>O cliente liga ou desliga o Google em "Minha conta".</li>
        </ul>
      </Card>
    </AppShell>
  );
}
