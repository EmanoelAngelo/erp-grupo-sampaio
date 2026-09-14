/**
 * "ABRIR OS" NO PDV DA OFICINA — GAP-PRD-099.
 *
 * ## O defeito
 *
 * `POST /core/workshop/orders` sempre nomeou o caixa da oficina, e o servidor
 * o recusava: a bancada era resolvida pela filiação, e o caixa não é membro de
 * bancada (no banco da loja, o usuário "PDV Oficina" não tem vínculo). E mesmo
 * que o servidor aceitasse, o caixa mora no ambiente `pdv` e não alcança o
 * quadro da oficina, onde fica o "Nova OS". O cliente chegava com a moto no
 * balcão, e quem estava no balcão não tinha como recebê-la.
 *
 * ## O conserto
 *
 * O servidor passou a usar a régua de quem ABRE (a empresa, para o balcão), e
 * o PDV ganha o gesto: cliente (do cadastro ou digitado), aparelho, placa ou
 * gaveta, o defeito e a prioridade. A OS nasce "em aberto", no quadro, para o
 * mecânico assumir — o mesmo nascimento da OS aberta pela bancada.
 */
import { useEffect, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Button, Field, Input } from './ui';
import { CampoBancada } from './BancadaDeEntrada';
import { useBancadasDeEntrada } from '@/hooks/useBancadasDeEntrada';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';
import { oficinaEntradaApi, precisaEscolherBancada, type OsAberta } from '@/lib/api/oficinaEntrada';
import { avisoDeMotoDoEstoque, motoDoEstoque } from '@/lib/api/fronteiraOficina';

const PRIORIDADES: { valor: string; rotulo: string }[] = [
  { valor: 'urgente', rotulo: 'Urgente' },
  { valor: 'alta', rotulo: 'Alta' },
  { valor: 'media', rotulo: 'Média' },
  { valor: 'baixa', rotulo: 'Baixa' },
];

interface Cadastro {
  id: string;
  rotulo: string;
  /** A moto do estoque do grupo, ainda não vendida (GAP-PRD-109). */
  estoque?: { loja: string | null } | null;
}

export function AbrirOsDialog({
  onAberta,
  onClose,
}: {
  onAberta: (os: OsAberta) => void;
  onClose: () => void;
}) {
  const bancadas = useBancadasDeEntrada(true);
  const [bancadaId, setBancadaId] = useState('');
  const [cliente, setCliente] = useState({ nome: '', id: '' });
  const [aparelho, setAparelho] = useState<{
    texto: string;
    id: string;
    estoque?: { loja: string | null } | null;
  }>({ texto: '', id: '' });
  const [placa, setPlaca] = useState('');
  const [defeito, setDefeito] = useState('');
  const [prioridade, setPrioridade] = useState('media');
  const [clientes, setClientes] = useState<Cadastro[]>([]);
  const [aparelhos, setAparelhos] = useState<Cadastro[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Esc fecha o diálogo, antes que o PDV o leia como atalho.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Busca no cadastro: falha não trava a abertura — o texto livre continua.
  const buscarClientes = async (termo: string) => {
    if (termo.trim().length < 2) {
      setClientes([]);
      return;
    }
    try {
      const achados = await coreApi.listCustomers(termo);
      setClientes(achados.slice(0, 5).map((c) => ({ id: c.id, rotulo: c.name })));
    } catch {
      setClientes([]);
    }
  };
  const buscarAparelhos = async (termo: string) => {
    if (termo.trim().length < 2) {
      setAparelhos([]);
      return;
    }
    try {
      const achados = await coreApi.listEquipment(termo);
      setAparelhos(
        achados.slice(0, 5).map((e) => ({
          id: e.id,
          rotulo: [e.brand, e.model].filter(Boolean).join(' ') || `#${e.public_id}`,
          estoque: motoDoEstoque(e),
        })),
      );
    } catch {
      setAparelhos([]);
    }
  };

  const abrir = async (event: React.FormEvent) => {
    event.preventDefault();
    setErro(null);
    // A moto do estoque não tem cliente (GAP-PRD-109): a OS é interna.
    if (!aparelho.estoque && !cliente.nome.trim() && !cliente.id) {
      setErro('Informe o cliente — do cadastro ou o nome de quem trouxe.');
      return;
    }
    const escolhe = precisaEscolherBancada(bancadas);
    if (escolhe && !bancadaId) {
      setErro('Escolha a bancada onde a OS vai entrar.');
      return;
    }
    setEnviando(true);
    try {
      const os = await oficinaEntradaApi.abrirOs({
        workshopId: escolhe ? bancadaId : undefined,
        // Moto do estoque: nenhum cliente do cadastro — o servidor o recusaria.
        customerName: aparelho.estoque
          ? cliente.nome.trim() || 'Montagem interna'
          : cliente.id
            ? undefined
            : cliente.nome.trim(),
        customerId: aparelho.estoque ? null : cliente.id || null,
        equipment: aparelho.id ? undefined : aparelho.texto.trim(),
        equipmentId: aparelho.id || null,
        plate: placa.trim(),
        complaint: defeito.trim(),
        priority: prioridade,
      });
      onAberta(os);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível abrir a OS.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label="Abrir OS"
    >
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Abrir OS
          </h2>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            O cliente deixou o aparelho no balcão: a OS nasce em aberto, no quadro da oficina, para
            o mecânico assumir.
          </p>
        </header>
        <form onSubmit={(e) => void abrir(e)} className="px-6 py-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <CampoBancada bancadas={bancadas} value={bancadaId} onChange={setBancadaId} />
          </div>
          <Field
            label="Cliente"
            required
            hint={
              aparelho.estoque
                ? 'Moto do estoque: OS interna, sem cliente'
                : cliente.id
                  ? 'Vinculado ao cadastro'
                  : 'Digite para buscar no cadastro, ou siga sem cadastrar'
            }
          >
            {(p) => (
              <Input
                {...p}
                autoFocus
                disabled={Boolean(aparelho.estoque)}
                value={cliente.nome}
                onChange={(e) => {
                  // Digitar de novo desfaz o vínculo com o cadastro.
                  setCliente({ nome: e.target.value, id: '' });
                  void buscarClientes(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Aparelho" hint={aparelho.id ? 'Vinculado ao cadastro' : 'Marca e modelo, ou busque pela plaquinha'}>
            {(p) => (
              <Input
                {...p}
                value={aparelho.texto}
                onChange={(e) => {
                  setAparelho({ texto: e.target.value, id: '' });
                  void buscarAparelhos(e.target.value);
                }}
              />
            )}
          </Field>
          {(clientes.length > 0 || aparelhos.length > 0) && (
            <div className="sm:col-span-2 flex flex-wrap gap-2">
              {clientes.map((c) => (
                <Button
                  key={c.id}
                  type="button"
                  size="sm"
                  variant={cliente.id === c.id ? 'primary' : 'secondary'}
                  onClick={() => {
                    setCliente({ nome: c.rotulo, id: c.id });
                    setClientes([]);
                  }}
                >
                  Cliente: {c.rotulo}
                </Button>
              ))}
              {aparelhos.map((a) => (
                <Button
                  key={a.id}
                  type="button"
                  size="sm"
                  variant={aparelho.id === a.id ? 'primary' : 'secondary'}
                  onClick={() => {
                    setAparelho({ texto: a.rotulo, id: a.id, estoque: a.estoque ?? null });
                    setAparelhos([]);
                    // A moto do estoque não é de ninguém ainda: a OS é interna.
                    if (a.estoque) {
                      setCliente({ nome: 'Montagem interna', id: '' });
                      setClientes([]);
                    }
                  }}
                >
                  Aparelho: {a.rotulo}
                </Button>
              ))}
            </div>
          )}
          {/* A MOTO DO ESTOQUE, DITA NA ABERTURA (GAP-PRD-109) — antes a guarda
              só existia na venda, e a OS nascia em nome de um cliente. */}
          {aparelho.estoque && (
            <p
              role="note"
              className="sm:col-span-2 m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                text-[length:var(--gs-text-sm)]"
            >
              {avisoDeMotoDoEstoque(aparelho.estoque)}
            </p>
          )}
          <Field label="Placa / gaveta">
            {(p) => <Input {...p} value={placa} onChange={(e) => setPlaca(e.target.value)} />}
          </Field>
          <Field label="Prioridade">
            {(p) => (
              <select
                {...p}
                value={prioridade}
                onChange={(e) => setPrioridade(e.target.value)}
                className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)] text-[var(--gs-text)]"
              >
                {PRIORIDADES.map((p2) => (
                  <option key={p2.valor} value={p2.valor}>
                    {p2.rotulo}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="sm:col-span-2">
            <Field label="Defeito relatado">
              {(p) => <Input {...p} value={defeito} onChange={(e) => setDefeito(e.target.value)} />}
            </Field>
          </div>
          {erro && (
            <p role="alert" className="sm:col-span-2 m-0 text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar (Esc)
            </Button>
            <Button type="submit" loading={enviando}>
              Abrir OS
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
