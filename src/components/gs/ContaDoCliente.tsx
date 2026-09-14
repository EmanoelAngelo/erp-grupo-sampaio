/**
 * Endereços salvos e troca de senha, na conta do cliente.
 *
 * Fica num arquivo próprio porque `MinhaContaPage` já responde por identidade
 * (entrar, sair) e pedidos; misturar cadastro ali faria a tela mais usada da
 * loja crescer com assuntos que não são dela.
 *
 * O endereço é da CONTA, não da operação onde a pessoa comprou — ver
 * `CustomerAccountService`. Aqui isso aparece como uma lista só, sem menção a
 * loja nenhuma.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { SenhaNovaComConfirmacao } from '@/components/gs/SenhaNova';
import { FormularioDeEndereco } from '@/components/gs/FormularioDeEndereco';
import {
  ROTULO_DO_TIPO,
  descreverFalta,
  enderecosApi,
  faltaParaEntregar,
  paraFormulario,
  serveParaEntrega,
  type DadosDoEndereco,
  type EnderecoDaConta,
} from '@/lib/api/enderecos';
import { problemaDaSenhaNova } from '@/lib/senhaNova';

/** O endereço da conta — o formato mora em `lib/api/enderecos` (GAP-PRD-115). */
export type Endereco = EnderecoDaConta;

interface Opcoes {
  method?: 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

/** Toda chamada do portal leva o token no header próprio. */
function comToken<T>(caminho: string, token: string, init: Opcoes = {}): Promise<T> {
  return apiRequest<T>(caminho, {
    ...init,
    anonymous: true,
    headers: { 'x-portal-token': token },
  });
}

/**
 * O perfil como o servidor devolve (GAP-PRD-133/205): os dados moram na
 * CONTA, e `nameSource` diz se o nome é dela ou, na conta antiga, do cadastro
 * vinculado mais recentemente. O documento volta mascarado — inteiro, nunca.
 */
export interface PerfilDoServidor {
  email: string;
  name: string | null;
  phone: string | null;
  nameSource?: 'conta' | 'cadastro' | null;
  documentMasked?: string | null;
  hasDocument?: boolean;
  emailVerified?: boolean;
  /** Falso = a conta entra só pelo Google e ainda não tem senha (GAP-PRD-027). */
  hasPassword?: boolean;
  faltando?: string[];
}

interface PerfilNaTela {
  email: string;
  name: string;
  phone: string;
  /** O que a pessoa está digitando — só quando a conta ainda não tem documento. */
  document: string;
  documentMasked: string | null;
  hasDocument: boolean;
  nameSource: 'conta' | 'cadastro' | null;
  hasPassword: boolean;
}

function paraTela(p: PerfilDoServidor): PerfilNaTela {
  return {
    email: p.email,
    name: p.name ?? '',
    phone: p.phone ?? '',
    document: '',
    documentMasked: p.documentMasked ?? null,
    hasDocument: Boolean(p.hasDocument),
    nameSource: p.nameSource ?? null,
    // Ausente (servidor anterior) = tem senha: é como toda conta nascia.
    hasPassword: p.hasPassword !== false,
  };
}

/** CEP formatado só para leitura; o servidor guarda os 8 dígitos. */
function cep(digitos: string): string {
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : digitos;
}

export function ContaDoCliente({ token }: { token: string }) {
  const [enderecos, setEnderecos] = useState<Endereco[] | null>(null);
  /** O endereço aberto no formulário: um id (editar), 'novo', ou nenhum. */
  const [editando, setEditando] = useState<string | null>(null);
  const [avisoEndereco, setAvisoEndereco] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);

  const [senha, setSenha] = useState({ atual: '', nova: '', confirmacao: '' });
  const [erroSenha, setErroSenha] = useState<string | null>(null);

  const [perfil, setPerfil] = useState<PerfilNaTela | null>(null);
  /** A falha do perfil precisa ter voz — ver o catch de carregarPerfil. */
  const [perfilFalhou, setPerfilFalhou] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await comToken<{ items: Endereco[] }>('/loja/portal/enderecos', token);
      setEnderecos(r.items);
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar seus endereços.');
    }
  }, [token]);

  const carregarPerfil = useCallback(async () => {
    try {
      const p = await comToken<PerfilDoServidor>('/loja/portal/perfil', token);
      setPerfil(paraTela(p));
      setPerfilFalhou(false);
    } catch {
      /*
        O perfil falhar não derruba o resto da conta — mas o catch VAZIO
        fazia o formulário "Meus dados" inteiro sumir sem uma palavra: quem
        veio corrigir o telefone (o dado que a loja usa para avisar da
        entrega) não encontrava a tela e não tinha como saber que existe.
      */
      setPerfilFalhou(true);
    }
  }, [token]);

  useEffect(() => {
    void carregar();
    void carregarPerfil();
  }, [carregar, carregarPerfil]);

  const salvarPerfil = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!perfil) return;
    setErro(null);
    setMensagem(null);
    try {
      // O documento só vai quando a conta ainda não tem um — ele se declara
      // uma vez, e reenviar o campo vazio não pode apagar nada.
      const corpo: Record<string, string> = { name: perfil.name, phone: perfil.phone };
      if (!perfil.hasDocument && perfil.document.trim()) corpo.document = perfil.document;
      const p = await comToken<PerfilDoServidor>('/loja/portal/perfil', token, {
        method: 'PUT',
        body: corpo,
      });
      setPerfil(paraTela(p));
      setMensagem('Dados atualizados.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar seus dados.');
    }
  };

  const sairDeOutros = async () => {
    setErro(null);
    setMensagem(null);
    try {
      const r = await comToken<{ message: string }>('/loja/portal/sair-outros', token, {
        method: 'POST',
      });
      setMensagem(r.message);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível encerrar as sessões.');
    }
  };

  /*
    CRIAR E EDITAR (GAP-PRD-115). Antes só existia criar: corrigir o número
    exigia apagar e recriar, e o recriado perdia o "padrão". A recusa do
    servidor sobe para o formulário, que a mostra no lugar.
  */
  const salvar = async (dados: DadosDoEndereco) => {
    setErro(null);
    if (editando && editando !== 'novo') {
      await enderecosApi.editar(token, editando, dados);
      setAvisoEndereco('Endereço atualizado. Pedidos já feitos continuam com o endereço da compra.');
    } else {
      await enderecosApi.criar(token, dados);
    }
    setEditando(null);
    await carregar();
  };

  const acao = async (caminho: string, method: 'POST' | 'DELETE') => {
    setErro(null);
    try {
      const r = await comToken<{ items: Endereco[] }>(caminho, token, { method });
      setEnderecos(r.items);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir.');
    }
  };

  const trocarSenha = async (e: React.FormEvent) => {
    e.preventDefault();
    setErroSenha(null);
    setMensagem(null);
    // A nova digitada duas vezes, conferida antes de enviar (GAP-PRD-192).
    const problema = problemaDaSenhaNova(senha.nova, senha.confirmacao);
    if (problema) {
      setErroSenha(problema);
      return;
    }
    try {
      const r = await comToken<{ message: string }>('/loja/portal/senha', token, {
        method: 'POST',
        body: { currentPassword: senha.atual, newPassword: senha.nova },
      });
      setSenha({ atual: '', nova: '', confirmacao: '' });
      setMensagem(r.message);
    } catch (err) {
      setErroSenha(err instanceof ApiRequestError ? err.message : 'Não foi possível trocar.');
    }
  };

  return (
    <section className="mt-8" data-testid="conta-do-cliente">
      {!perfil && perfilFalhou && (
        <div className="mb-8">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] mb-3">
            Meus dados
          </h2>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
            Não deu para carregar seus dados agora.
          </p>
          <button
            type="button"
            aria-label="Tentar carregar meus dados de novo"
            onClick={() => void carregarPerfil()}
            className="mt-2 bg-transparent border border-[var(--gs-border-strong)]
              rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer text-[length:var(--gs-text-sm)]
              font-semibold"
          >
            Tentar de novo
          </button>
        </div>
      )}

      {perfil && (
        <form onSubmit={(e) => void salvarPerfil(e)} className="mb-8">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] mb-3">
            Meus dados
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-sm)] font-semibold">Nome</span>
              <input
                aria-label="Nome"
                value={perfil.name}
                onChange={(e) => setPerfil({ ...perfil, name: e.target.value })}
                className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
              />
              {/* Conta antiga, sem nome próprio: o nome veio do cadastro da
                  compra mais recente (GAP-PRD-205) — a tela diz isso. */}
              {perfil.nameSource === 'cadastro' && (
                <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                  Veio do cadastro da sua compra mais recente. Salve para guardar na sua conta.
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-sm)] font-semibold">Telefone</span>
              <input
                aria-label="Telefone"
                inputMode="tel"
                value={perfil.phone}
                onChange={(e) => setPerfil({ ...perfil, phone: e.target.value })}
                className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
              />
            </label>
            {/*
              O CPF/CNPJ DA CONTA (GAP-PRD-028/133). É por ele que a nota e a
              cobrança do pedido saem — e ele se declara UMA vez: depois de
              salvo, a tela mostra só o final, e trocar é com a loja.
            */}
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-sm)] font-semibold">CPF ou CNPJ</span>
              {perfil.hasDocument ? (
                <input
                  disabled
                  aria-label="CPF ou CNPJ"
                  value={perfil.documentMasked ?? ''}
                  className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                    bg-[var(--gs-surface-hover)] text-[var(--gs-muted)]"
                />
              ) : (
                <input
                  aria-label="CPF ou CNPJ"
                  inputMode="numeric"
                  value={perfil.document}
                  onChange={(e) => setPerfil({ ...perfil, document: e.target.value })}
                  className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                />
              )}
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                {perfil.hasDocument
                  ? 'Para trocar o CPF/CNPJ da conta, fale com a loja.'
                  : 'A nota fiscal e a cobrança dos seus pedidos saem neste documento.'}
              </span>
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-[length:var(--gs-text-sm)] font-semibold">E-mail (login)</span>
              <input
                disabled
                aria-label="E-mail"
                value={perfil.email}
                className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                  bg-[var(--gs-surface-hover)] text-[var(--gs-muted)]"
              />
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                O e-mail é o seu login e não muda por aqui.
              </span>
            </label>
          </div>
          <button
            type="submit"
            className="mt-3 bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
              px-4 py-2 cursor-pointer font-semibold"
          >
            Salvar dados
          </button>
        </form>
      )}

      <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] mb-3">
        Meus endereços
      </h2>

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}

      {avisoEndereco && (
        <p role="status" className="text-[length:var(--gs-text-sm)] mt-0">
          {avisoEndereco}
        </p>
      )}

      <ul className="list-none p-0 m-0 flex flex-col gap-2 mb-3">
        {(enderecos ?? []).map((e) =>
          editando === e.id ? (
            <li key={e.id}>
              <FormularioDeEndereco
                titulo={`Editar ${e.label ?? 'endereço'}`}
                inicial={paraFormulario(e)}
                rotuloSalvar="Salvar alterações"
                onSalvar={salvar}
                onCancelar={() => setEditando(null)}
              />
            </li>
          ) : (
          <li
            key={e.id}
            className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
              rounded-[var(--gs-radius)] p-4 flex flex-wrap items-start justify-between gap-3"
          >
            <div>
              <strong className="block">
                {e.label ?? 'Endereço'}
                {e.isDefault && (
                  <span
                    className="ml-2 px-2 py-0.5 rounded-[var(--gs-radius)] bg-[var(--gs-purple-100)]
                      text-[var(--gs-purple-800)] text-[length:var(--gs-text-xs)] font-semibold"
                  >
                    Padrão
                  </span>
                )}
                {/* Para que serve (GAP-PRD-115): entrega, nota fiscal ou os dois. */}
                {e.kind && (
                  <span
                    className="ml-2 px-2 py-0.5 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                      text-[var(--gs-muted)] text-[length:var(--gs-text-xs)] font-normal"
                  >
                    {ROTULO_DO_TIPO[e.kind]}
                  </span>
                )}
              </strong>
              {e.recipientName && (
                <span className="block text-[length:var(--gs-text-sm)]">Recebe: {e.recipientName}</span>
              )}
              <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {e.street}
                {e.number ? `, ${e.number}` : ''}
                {e.complement ? ` — ${e.complement}` : ''}
                {e.district ? ` · ${e.district}` : ''}
              </span>
              <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {e.city}/{e.state} · CEP {cep(e.zip)}
                {e.cityIbge ? ` · IBGE ${e.cityIbge}` : ''}
              </span>
              {/* O que falta para RECEBER um pedido (GAP-PRD-028): o checkout
                  recusa entrega em endereço incompleto; "Editar" completa. */}
              {serveParaEntrega(e) && faltaParaEntregar(e).length > 0 && (
                <span role="status" className="block text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                  Para receber entregas, falta {descreverFalta(faltaParaEntregar(e))}. Use “Editar” para
                  completar.
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label={`Editar ${e.label ?? 'endereço'}`}
                onClick={() => {
                  setAvisoEndereco(null);
                  setEditando(e.id);
                }}
                className="bg-transparent border border-[var(--gs-border-strong)]
                  rounded-[var(--gs-radius)] px-3 py-1 cursor-pointer text-[length:var(--gs-text-sm)]"
              >
                Editar
              </button>
              {!e.isDefault && (
                <button
                  type="button"
                  onClick={() => void acao(`/loja/portal/enderecos/${e.id}/padrao`, 'POST')}
                  className="bg-transparent border border-[var(--gs-border-strong)]
                    rounded-[var(--gs-radius)] px-3 py-1 cursor-pointer text-[length:var(--gs-text-sm)]"
                >
                  Usar como padrão
                </button>
              )}
              <button
                type="button"
                aria-label={`Remover ${e.label ?? 'endereço'}`}
                onClick={() => void acao(`/loja/portal/enderecos/${e.id}`, 'DELETE')}
                /*
                  Mesma anatomia do vizinho "Usar como padrão" — o botão
                  DESTRUTIVO era o menor alvo do par, texto pelado colado no
                  outro. E a cor diz o que ele faz.
                */
                className="bg-transparent border border-[var(--gs-border-strong)]
                  rounded-[var(--gs-radius)] px-3 py-1 cursor-pointer
                  text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
              >
                Remover
              </button>
            </div>
          </li>
          ),
        )}
      </ul>

      {enderecos?.length === 0 && editando !== 'novo' && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0">
          Nenhum endereço salvo. Guardar um agora evita digitar tudo na próxima compra.
        </p>
      )}

      {editando === 'novo' ? (
        <FormularioDeEndereco onSalvar={salvar} onCancelar={() => setEditando(null)} />
      ) : (
        <button
          type="button"
          onClick={() => {
            setAvisoEndereco(null);
            setEditando('novo');
          }}
          className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer font-semibold"
        >
          Adicionar endereço
        </button>
      )}

      <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] mt-8 mb-3">
        {perfil && !perfil.hasPassword ? 'Senha' : 'Trocar senha'}
      </h2>

      {/*
        CONTA QUE ENTRA SÓ PELO GOOGLE (GAP-PRD-027): não há "senha atual" para
        digitar, e o servidor recusaria a troca. A primeira senha nasce pela
        recuperação — o link vai para a caixa que o Google já provou.
      */}
      {perfil && !perfil.hasPassword ? (
        <p
          data-testid="conta-sem-senha"
          className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-4
            text-[length:var(--gs-text-sm)] m-0"
        >
          Sua conta entra pelo Google e ainda não tem senha. Para criar uma, saia e use
          "Esqueci minha senha" na tela de entrar: o link chega no seu e-mail.
        </p>
      ) : (
      <form
        onSubmit={(e) => void trocarSenha(e)}
        className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
          rounded-[var(--gs-radius)] p-4 grid gap-3 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1">
          <span className="text-[length:var(--gs-text-sm)] font-semibold">Senha atual</span>
          <input
            required
            type="password"
            autoComplete="current-password"
            aria-label="Senha atual"
            value={senha.atual}
            onChange={(e) => setSenha({ ...senha, atual: e.target.value })}
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          />
        </label>
        <SenhaNovaComConfirmacao
          rotulo="Nova senha"
          rotuloConfirmacao="Confirme a nova senha"
          senha={senha.nova}
          confirmacao={senha.confirmacao}
          onSenha={(v) => setSenha((s) => ({ ...s, nova: v }))}
          onConfirmacao={(v) => setSenha((s) => ({ ...s, confirmacao: v }))}
        />

        {erroSenha && (
          <p role="alert" className="sm:col-span-2 m-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
            {erroSenha}
          </p>
        )}
        {mensagem && (
          <p role="status" className="sm:col-span-2 m-0 text-[length:var(--gs-text-sm)]">
            {mensagem}
          </p>
        )}

        <div className="sm:col-span-2">
          <button
            type="submit"
            className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
              px-4 py-2 cursor-pointer font-semibold"
          >
            Trocar senha
          </button>
          {/* Dizer o efeito ANTES evita o susto de ser desconectado no celular
              sem entender por quê. */}
          <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] mt-2">
            Trocar a senha encerra as sessões abertas em outros aparelhos.
          </span>
        </div>
      </form>
      )}

      <div className="mt-8 pt-6 border-t border-[var(--gs-border)]">
        <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] mb-2">
          Dispositivos
        </h2>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-3">
          Entrou num computador público e esqueceu de sair? Encerre as outras
          sessões sem mudar a sua senha. A sessão deste aparelho continua.
        </p>
        <button
          type="button"
          onClick={() => void sairDeOutros()}
          className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer font-semibold"
        >
          Sair dos outros dispositivos
        </button>
      </div>
    </section>
  );
}
