/**
 * Categorias, subcategorias e marcas.
 *
 * Antes eram texto livre no cadastro: "Masculino" num produto e "masculino"
 * noutro viravam duas, e o filtro da vitrine mostrava metade das peças em cada
 * uma. Esta tela define o que PODE ser escolhido.
 *
 * A lista sozinha só impede erro novo. O que conserta o catálogo já torto é a
 * FUSÃO — por isso ela tem lugar de destaque, e não escondida num menu.
 */
import { useCallback, useEffect, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Brand, type Category, type Taxonomy } from '@/lib/api/core';

export default function CategoriasMarcasPage() {
  const [data, setData] = useState<Taxonomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setError(null);
    try {
      setData(await coreApi.getTaxonomy());
    } catch (err) {
      setData(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const acao = useCallback(
    async (fn: () => Promise<unknown>, mensagem?: string) => {
      setError(null);
      setAviso(null);
      try {
        await fn();
        if (mensagem) setAviso(mensagem);
        await carregar();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha na operação.');
      }
    },
    [carregar],
  );

  const soltos = data?.orphans;
  const totalSoltos =
    (soltos?.categories.length ?? 0) +
    (soltos?.subcategories.length ?? 0) +
    (soltos?.brands.length ?? 0);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Categorias e marcas']}
        title="Categorias e marcas"
        subtitle="Define o que pode ser escolhido no cadastro. Renomear ou unir leva os produtos junto."
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

      {/* Valores que estão nos produtos mas fora da lista. Sem mostrar isso, a
          lista viraria enfeite enquanto o catálogo real seguisse solto. */}
      {totalSoltos > 0 && (
        <Card
          title={`${totalSoltos} valor(es) fora da lista`}
          subtitle="Estão escritos em produtos mas não foram cadastrados aqui. Clique para incluir."
          className="mb-6"
        >
          <div className="flex flex-col gap-3">
            <SoltosLinha
              rotulo="Categorias"
              valores={soltos?.categories ?? []}
              onIncluir={(nome) =>
                void acao(
                  () => coreApi.saveCategory({ name: nome }),
                  `"${nome}" incluída nas categorias.`,
                )
              }
            />
            <SoltosLinha
              rotulo="Subcategorias"
              valores={soltos?.subcategories ?? []}
              // Subcategoria precisa de pai: sem escolher a categoria, a
              // inclusão em um clique criaria uma raiz errada.
              hint="Cadastre dentro da categoria correspondente, abaixo."
            />
            <SoltosLinha
              rotulo="Marcas"
              valores={soltos?.brands ?? []}
              onIncluir={(nome) =>
                void acao(() => coreApi.saveBrand({ name: nome }), `"${nome}" incluída nas marcas.`)
              }
            />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CategoriasCard
          categorias={data?.categories ?? []}
          carregando={data === null && !error}
          onAcao={acao}
        />
        <MarcasCard marcas={data?.brands ?? []} carregando={data === null && !error} onAcao={acao} />
      </div>
    </AppShell>
  );
}

function SoltosLinha({
  rotulo,
  valores,
  hint,
  onIncluir,
}: {
  rotulo: string;
  valores: string[];
  hint?: string;
  onIncluir?: (nome: string) => void;
}) {
  if (valores.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)]">
        {rotulo}
      </span>
      <div className="flex flex-wrap gap-2">
        {valores.map((v) =>
          onIncluir ? (
            <button
              key={v}
              type="button"
              onClick={() => onIncluir(v)}
              className="px-3 py-1.5 rounded-full border border-[var(--gs-border)] bg-[var(--gs-surface)]
                text-[length:var(--gs-text-sm)] hover:border-[var(--gs-purple-700)]"
            >
              {v} <span className="text-[var(--gs-purple-700)] font-bold">+</span>
            </button>
          ) : (
            <span
              key={v}
              className="px-3 py-1.5 rounded-full border border-[var(--gs-border)]
                bg-[var(--gs-canvas)] text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]"
            >
              {v}
            </span>
          ),
        )}
      </div>
      {hint && <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{hint}</span>}
    </div>
  );
}

// ------------------------------------------------------------- categorias

function CategoriasCard({
  categorias,
  carregando,
  onAcao,
}: {
  categorias: Category[];
  carregando: boolean;
  onAcao: (fn: () => Promise<unknown>, mensagem?: string) => void;
}) {
  const [nova, setNova] = useState('');
  const [fundindo, setFundindo] = useState<Category | null>(null);

  return (
    <Card title="Categorias" subtitle="Dois níveis: categoria e subcategoria.">
      <div className="flex flex-col gap-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nova.trim()) return;
            onAcao(() => coreApi.saveCategory({ name: nova }), `"${nova}" criada.`);
            setNova('');
          }}
        >
          <Input value={nova} onChange={(e) => setNova(e.target.value)} placeholder="Nova categoria" />
          <Button type="submit">Criar</Button>
        </form>

        {carregando ? (
          <p role="status" className="text-[var(--gs-muted)]">
            Carregando…
          </p>
        ) : categorias.length === 0 ? (
          <EmptyState
            title="Nenhuma categoria"
            description="Crie a primeira acima. O cadastro de produto passa a escolher desta lista."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {categorias.map((cat) => (
              <li key={cat.id} className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] p-3">
                <Linha
                  item={cat}
                  onRenomear={(nome) =>
                    onAcao(
                      () => coreApi.saveCategory({ id: cat.id, name: nome }),
                      `Renomeada para "${nome}" — os produtos foram junto.`,
                    )
                  }
                  onRemover={() =>
                    onAcao(() => coreApi.removeCategory(cat.id), `"${cat.name}" removida.`)
                  }
                  onFundir={() => setFundindo(cat)}
                />

                <SubcategoriaForm
                  parentId={cat.id}
                  onCriar={(nome) =>
                    onAcao(
                      () => coreApi.saveCategory({ name: nome, parentId: cat.id }),
                      `"${nome}" criada em ${cat.name}.`,
                    )
                  }
                />

                {(cat.children ?? []).length > 0 && (
                  <ul className="mt-2 ml-4 flex flex-col gap-1.5 border-l-2 border-[var(--gs-border)] pl-3">
                    {cat.children!.map((sub) => (
                      <li key={sub.id}>
                        <Linha
                          item={sub}
                          onRenomear={(nome) =>
                            onAcao(
                              () =>
                                coreApi.saveCategory({
                                  id: sub.id,
                                  name: nome,
                                  parentId: cat.id,
                                }),
                              `Renomeada para "${nome}" — os produtos foram junto.`,
                            )
                          }
                          onRemover={() =>
                            onAcao(() => coreApi.removeCategory(sub.id), `"${sub.name}" removida.`)
                          }
                          onFundir={() => setFundindo(sub)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {fundindo && (
        <FusaoDialog
          origem={fundindo}
          // Só faz sentido unir com algo do MESMO nível: o produto guarda
          // categoria e subcategoria em colunas diferentes.
          candidatos={(fundindo.parent_id
            ? (categorias.find((c) => c.id === fundindo.parent_id)?.children ?? [])
            : categorias
          ).filter((c) => c.id !== fundindo.id)}
          onClose={() => setFundindo(null)}
          onConfirmar={(destino) => {
            onAcao(
              () => coreApi.mergeCategory(fundindo.id, destino.id),
              `"${fundindo.name}" unida em "${destino.name}" — os produtos migraram.`,
            );
            setFundindo(null);
          }}
        />
      )}
    </Card>
  );
}

function SubcategoriaForm({
  parentId,
  onCriar,
}: {
  parentId: string;
  onCriar: (nome: string) => void;
}) {
  const [valor, setValor] = useState('');
  void parentId;
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valor.trim()) return;
        onCriar(valor);
        setValor('');
      }}
    >
      <Input
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        placeholder="Nova subcategoria"
      />
      <Button type="submit" size="sm" variant="ghost">
        Adicionar
      </Button>
    </form>
  );
}

// ----------------------------------------------------------------- marcas

function MarcasCard({
  marcas,
  carregando,
  onAcao,
}: {
  marcas: Brand[];
  carregando: boolean;
  onAcao: (fn: () => Promise<unknown>, mensagem?: string) => void;
}) {
  const [nova, setNova] = useState('');
  const [fundindo, setFundindo] = useState<Brand | null>(null);

  return (
    <Card title="Marcas">
      <div className="flex flex-col gap-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nova.trim()) return;
            onAcao(() => coreApi.saveBrand({ name: nova }), `"${nova}" criada.`);
            setNova('');
          }}
        >
          <Input value={nova} onChange={(e) => setNova(e.target.value)} placeholder="Nova marca" />
          <Button type="submit">Criar</Button>
        </form>

        {carregando ? (
          <p role="status" className="text-[var(--gs-muted)]">
            Carregando…
          </p>
        ) : marcas.length === 0 ? (
          <EmptyState title="Nenhuma marca" description="Crie a primeira acima." />
        ) : (
          <ul className="flex flex-col gap-2">
            {marcas.map((m) => (
              <li key={m.id} className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] p-3">
                <Linha
                  item={m}
                  onRenomear={(nome) =>
                    onAcao(
                      () => coreApi.saveBrand({ id: m.id, name: nome }),
                      `Renomeada para "${nome}" — os produtos foram junto.`,
                    )
                  }
                  onRemover={() => onAcao(() => coreApi.removeBrand(m.id), `"${m.name}" removida.`)}
                  onFundir={() => setFundindo(m)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {fundindo && (
        <FusaoDialog
          origem={fundindo}
          candidatos={marcas.filter((m) => m.id !== fundindo.id)}
          onClose={() => setFundindo(null)}
          onConfirmar={(destino) => {
            onAcao(
              () => coreApi.mergeBrand(fundindo.id, destino.id),
              `"${fundindo.name}" unida em "${destino.name}" — os produtos migraram.`,
            );
            setFundindo(null);
          }}
        />
      )}
    </Card>
  );
}

// --------------------------------------------------------------- comuns

interface Nomeavel {
  id: string;
  name: string;
  usage: number;
}

function Linha({
  item,
  onRenomear,
  onRemover,
  onFundir,
}: {
  item: Nomeavel;
  onRenomear: (nome: string) => void;
  onRemover: () => void;
  onFundir: () => void;
}) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(item.name);

  if (editando) {
    return (
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onRenomear(valor);
          setEditando(false);
        }}
      >
        <Input value={valor} onChange={(e) => setValor(e.target.value)} autoFocus />
        <Button type="submit" size="sm">
          Salvar
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setValor(item.name);
            setEditando(false);
          }}
        >
          Cancelar
        </Button>
      </form>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <span className="flex items-center gap-2">
        <strong className="text-[var(--gs-purple-900)]">{item.name}</strong>
        {/* A contagem é o que diz ao gestor se pode remover — e quanto uma
            fusão vai mexer. */}
        <Badge tone={item.usage > 0 ? 'success' : 'neutral'}>
          {item.usage} produto{item.usage === 1 ? '' : 's'}
        </Badge>
      </span>
      <span className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
          Renomear
        </Button>
        <Button size="sm" variant="ghost" onClick={onFundir}>
          Unir
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemover}>
          Remover
        </Button>
      </span>
    </div>
  );
}

function FusaoDialog<T extends Nomeavel>({
  origem,
  candidatos,
  onClose,
  onConfirmar,
}: {
  origem: T;
  candidatos: T[];
  onClose: () => void;
  onConfirmar: (destino: T) => void;
}) {
  const [destinoId, setDestinoId] = useState('');
  const destino = candidatos.find((c) => c.id === destinoId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={`Unir ${origem.name}`}
    >
      <div className="w-full max-w-lg rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Unir &ldquo;{origem.name}&rdquo;
          </h2>
        </header>

        <div className="px-6 py-5 flex flex-col gap-4">
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Os {origem.usage} produto(s) de &ldquo;{origem.name}&rdquo; passam para o destino, e
            &ldquo;{origem.name}&rdquo; deixa de existir. A operação não pode ser desfeita com um
            clique.
          </p>

          {candidatos.length === 0 ? (
            <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]">
              Não há outro item do mesmo nível para unir.
            </p>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                Manter qual nome?
              </span>
              <select
                value={destinoId}
                onChange={(e) => setDestinoId(e.target.value)}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
              >
                <option value="">Escolha o destino</option>
                {candidatos.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.usage} produto{c.usage === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button disabled={!destino} onClick={() => destino && onConfirmar(destino)}>
              Unir
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
