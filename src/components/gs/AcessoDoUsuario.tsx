/**
 * O EDITOR DE ACESSO de uma pessoa: em quais EMPRESAS ela entra, em quais PDVs
 * (caixas) de cada uma, e quais PÁGINAS/MÓDULOS abrem para ela.
 *
 * O ponto de partida é um MODELO (os perfis de hoje e os atalhos Somente PDV,
 * PDV + Painel, Estoque…); marcar ou desmarcar uma página em cima dele vira a
 * personalização do vínculo. A tela não guarda regra nenhuma: o servidor
 * recusa o que quem está na tela não pode dar, e responde com o acesso gravado.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  acessoApi,
  type AcessoNaEmpresa,
  type AreaDoCatalogo,
  type ModeloDoCatalogo,
} from '@/lib/api/acesso';

interface Rascunho {
  vinculado: boolean;
  modelo: string;
  capabilities: Set<string>;
  terminais: 'todos' | string[];
}

const MODELO_INICIAL = 'somente_pdv';

function rascunhoDe(e: AcessoNaEmpresa): Rascunho {
  return {
    vinculado: e.vinculado,
    modelo: e.modelo?.code ?? MODELO_INICIAL,
    capabilities: new Set(e.capabilities),
    terminais: e.terminais === 'todos' ? 'todos' : [...e.terminais],
  };
}

export function AcessoDoUsuario({
  userId,
  nome,
  onFechar,
  onSalvo,
}: {
  userId: string;
  nome: string;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [areas, setAreas] = useState<AreaDoCatalogo[]>([]);
  const [modelos, setModelos] = useState<ModeloDoCatalogo[]>([]);
  const [empresas, setEmpresas] = useState<AcessoNaEmpresa[] | null>(null);
  const [rascunhos, setRascunhos] = useState<Record<string, Rascunho>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let vivo = true;
    Promise.all([acessoApi.catalogo(), acessoApi.doUsuario(userId)])
      .then(([catalogo, acesso]) => {
        if (!vivo) return;
        setAreas(catalogo.areas);
        setModelos(catalogo.modelos);
        setEmpresas(acesso.empresas);
        setRascunhos(Object.fromEntries(acesso.empresas.map((e) => [e.companyId, rascunhoDe(e)])));
      })
      .catch((err) => {
        if (vivo) setError(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar o acesso.');
      });
    return () => {
      vivo = false;
    };
  }, [userId]);

  const modeloPorCodigo = useMemo(() => new Map(modelos.map((m) => [m.code, m])), [modelos]);

  const mudar = (companyId: string, fn: (r: Rascunho) => Rascunho) =>
    setRascunhos((prev) => ({ ...prev, [companyId]: fn(prev[companyId]!) }));

  const aplicarModelo = (companyId: string, codigo: string) =>
    mudar(companyId, (r) => ({
      ...r,
      modelo: codigo,
      capabilities: new Set(modeloPorCodigo.get(codigo)?.capabilities ?? []),
    }));

  const alternarCapability = (companyId: string, code: string) =>
    mudar(companyId, (r) => {
      const capabilities = new Set(r.capabilities);
      if (capabilities.has(code)) capabilities.delete(code);
      else capabilities.add(code);
      return { ...r, capabilities };
    });

  const alternarCaixa = (companyId: string, caixaId: string) =>
    mudar(companyId, (r) => {
      const atuais = r.terminais === 'todos' ? [] : r.terminais;
      return {
        ...r,
        terminais: atuais.includes(caixaId) ? atuais.filter((t) => t !== caixaId) : [...atuais, caixaId],
      };
    });

  const salvar = async () => {
    if (!empresas) return;
    setError(null);
    setBusy(true);
    try {
      await acessoApi.salvar(
        userId,
        empresas
          .filter((e) => e.podeEditar)
          .map((e) => {
            const r = rascunhos[e.companyId]!;
            return r.vinculado
              ? {
                  companyId: e.companyId,
                  vinculado: true,
                  modelo: r.modelo,
                  capabilities: [...r.capabilities].sort(),
                  terminais: r.terminais,
                }
              : { companyId: e.companyId, vinculado: false };
          }),
      );
      onSalvo();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar o acesso.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`Acesso de ${nome}`} subtitle="Empresas, PDVs e páginas que esta pessoa pode usar">
      {error && (
        <p
          role="alert"
          className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {error}
        </p>
      )}
      {!empresas && !error && <p className="text-[var(--gs-muted)]">Carregando…</p>}
      {empresas && (
        <div className="flex flex-col gap-4">
          {empresas.map((e) => {
            const r = rascunhos[e.companyId]!;
            const travada = !e.podeEditar;
            return (
              <fieldset
                key={e.companyId}
                aria-label={`Empresa ${e.tradeName}`}
                disabled={travada || busy}
                className="border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-4 flex flex-col gap-3"
              >
                <legend className="px-1 font-semibold text-[var(--gs-purple-900)]">{e.tradeName}</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={r.vinculado}
                    onChange={(ev) => mudar(e.companyId, (x) => ({ ...x, vinculado: ev.target.checked }))}
                  />
                  Tem acesso a {e.tradeName}
                  {travada && <Badge tone="info">você não administra os usuários desta empresa</Badge>}
                  {e.modelo?.personalizado && <Badge tone="info">personalizado</Badge>}
                </label>

                {r.vinculado && (
                  <>
                    <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                      Modelo de partida
                      <select
                        aria-label={`Modelo em ${e.tradeName}`}
                        value={r.modelo}
                        onChange={(ev) => aplicarModelo(e.companyId, ev.target.value)}
                        className="h-[44px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                      >
                        {!modeloPorCodigo.has(r.modelo) && <option value={r.modelo}>{r.modelo}</option>}
                        {modelos.map((m) => (
                          <option key={m.code} value={m.code}>
                            {m.nome}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="flex flex-col gap-1">
                      <span className="text-[length:var(--gs-text-sm)] font-semibold">PDVs (caixas)</span>
                      {e.caixas.length === 0 ? (
                        <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          Esta empresa ainda não tem caixas cadastrados — o acesso ao PDV vale para o PDV da empresa.
                        </span>
                      ) : (
                        <>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`caixas-${e.companyId}`}
                              checked={r.terminais === 'todos'}
                              onChange={() => mudar(e.companyId, (x) => ({ ...x, terminais: 'todos' }))}
                            />
                            Todos os PDVs (inclusive os que forem criados)
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`caixas-${e.companyId}`}
                              checked={r.terminais !== 'todos'}
                              onChange={() => mudar(e.companyId, (x) => ({ ...x, terminais: [] }))}
                            />
                            Somente os PDVs marcados
                          </label>
                          {r.terminais !== 'todos' && (
                            <div className="flex flex-wrap gap-3 pl-6">
                              {e.caixas.map((c) => (
                                <label key={c.id} className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={(r.terminais as string[]).includes(c.id)}
                                    onChange={() => alternarCaixa(e.companyId, c.id)}
                                  />
                                  {c.nome}
                                </label>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    <div className="flex flex-col gap-1">
                      <span className="text-[length:var(--gs-text-sm)] font-semibold">
                        Páginas e módulos ({r.capabilities.size} liberados)
                      </span>
                      {areas.map((a) => {
                        const marcadas = a.capabilities.filter((c) => r.capabilities.has(c.code)).length;
                        return (
                          <details key={a.area} className="border-t border-[var(--gs-border)] py-1">
                            <summary className="cursor-pointer">
                              {a.area}{' '}
                              <span className="text-[var(--gs-muted)] text-[length:var(--gs-text-xs)]">
                                {marcadas}/{a.capabilities.length}
                              </span>
                            </summary>
                            <div className="grid sm:grid-cols-2 gap-1 pl-4 py-1">
                              {a.capabilities.map((c) => (
                                <label key={c.code} className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
                                  <input
                                    type="checkbox"
                                    checked={r.capabilities.has(c.code)}
                                    onChange={() => alternarCapability(e.companyId, c.code)}
                                  />
                                  {c.rotulo}
                                </label>
                              ))}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </>
                )}
              </fieldset>
            );
          })}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={onFechar} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={() => void salvar()} disabled={busy}>
              {busy ? 'Salvando…' : 'Salvar acesso'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
