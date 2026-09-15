/**
 * Oficina › Oficinas e bancadas.
 *
 * As duas oficinas do grupo trabalham diferente, e a tela mostra isso em vez de
 * fingir que são iguais:
 *
 *   MOBILIDADE     moto, bike e patinete ficam dias no pátio. A PLAQUINHA é
 *                  como se acha o aparelho e como o cliente acompanha.
 *   CELULARES      o aparelho entra e sai no mesmo dia, e vai para gaveta
 *                  identificada pela própria OS. Plaquinha não serve — e
 *                  oferecer o botão ensina a usar o que não se usa.
 *
 * As capacidades vêm do SERVIDOR. Repetir a regra aqui faria as duas divergirem
 * na primeira mudança, e a tela ofereceria o que a API recusa.
 *
 * O vínculo com a bancada é o que impede quem conserta celular de mexer na
 * oficina de mobilidade: pertencer à mesma empresa não basta.
 *
 * ## EM NOME DE QUEM A BANCADA IMPRIME
 *
 * A Ordem de Serviço da Oficina saía com o nome PJ MOTORS. O vínculo é
 * legítimo — quem vendeu a moto responde pela garantia dela —, mas ele morava
 * numa MIGRAÇÃO, cravado em código e reimposto a cada subida do servidor: não
 * havia onde mudar, e mudar no banco durava até o próximo deploy.
 *
 * Aqui a escolha aparece, com o nome que o cliente vai ler no papel. "Em nome
 * próprio" é o padrão, e é o que a Oficina usa.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { useEmpresaTemPlaquinha } from '@/hooks/useEmpresaTemPlaquinha';
import {
  coreApi,
  type Company,
  type TeamMember,
  type Workshop,
  type WorkshopBrand,
  type WorkshopMember,
} from '@/lib/api/core';

export default function OficinasPage() {
  const [oficinas, setOficinas] = useState<Workshop[] | null>(null);
  const [equipe, setEquipe] = useState<TeamMember[]>([]);
  const [membros, setMembros] = useState<Record<string, WorkshopMember[]>>({});
  const [marcas, setMarcas] = useState<Record<string, WorkshopBrand>>({});
  const [empresas, setEmpresas] = useState<Company[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /*
    A PLAQUINHA SAIU DO RETRATO DA BANCADA fora da PJ Motors (P0 das
    plaquinhas). A de mobilidade da Oficina aparecia com o selo "Plaquinha do
    equipamento" e a frase de como o cliente acompanha pela plaquinha — uma
    função que a Oficina não tem mais. A capacidade da bancada continua no
    servidor (é ela que decide o QR de acompanhamento da OS); a tela só deixa
    de anunciar plaquinha onde ela não existe.
  */
  const temPlaquinha = useEmpresaTemPlaquinha();

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const lista = await coreApi.listWorkshops();
      setOficinas(lista);
      setEquipe(await coreApi.listTeam());

      const porOficina: Record<string, WorkshopMember[]> = {};
      for (const w of lista) {
        porOficina[w.id] = await coreApi.listWorkshopMembers(w.id);
      }
      setMembros(porOficina);

      const porBancada: Record<string, WorkshopBrand> = {};
      for (const m of await coreApi.listWorkshopBrands()) porBancada[m.workshopId] = m;
      setMarcas(porBancada);
    } catch (err) {
      setOficinas(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as oficinas.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /*
    As operações do grupo, para o seletor de marca. Falha aqui NÃO derruba a
    tela: sem a lista o seletor some e o resto — bancadas, vínculos — continua.
    Só admin do grupo enxerga `/core/companies`, e um gerente de loja tem o que
    fazer nesta tela.
  */
  useEffect(() => {
    let vivo = true;
    void coreApi
      .listCompanies()
      .then((lista) => {
        if (vivo) setEmpresas(lista);
      })
      .catch(() => {
        if (vivo) setEmpresas([]);
      });
    return () => {
      vivo = false;
    };
  }, []);

  const trocarMarca = async (workshopId: string, brandCompanyId: string | null) => {
    setErro(null);
    setAviso(null);
    try {
      await coreApi.setWorkshopBrand(workshopId, brandCompanyId);
      setAviso('Identidade do documento atualizada.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao trocar a identidade.');
    }
  };

  const incluir = async (workshopId: string, userId: string) => {
    setErro(null);
    setAviso(null);
    try {
      const res = await coreApi.addWorkshopMember(workshopId, userId);
      setAviso(res.alreadyMember ? 'Já estava nesta bancada.' : 'Incluído na bancada.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao incluir.');
    }
  };

  const remover = async (workshopId: string, userId: string) => {
    setErro(null);
    try {
      await coreApi.removeWorkshopMember(workshopId, userId);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao remover.');
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Oficina', 'Oficinas']}
        title="Oficinas e bancadas"
        subtitle="Cada oficina faz o que faz sentido para o que ela conserta — e quem trabalha em qual bancada."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {oficinas === null ? (
        <Card title="Oficinas">
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">Carregando…</p>
        </Card>
      ) : oficinas.length === 0 ? (
        <Card title="Oficinas">
          <EmptyState
            title="Nenhuma oficina nesta operação"
            description="As oficinas do grupo são a de Mobilidade Elétrica e a de Celulares."
          />
        </Card>
      ) : (
        oficinas.map((w) => {
          const daBancada = membros[w.id] ?? [];
          const naBancada = new Set(daBancada.map((m) => m.user_id));
          const disponiveis = equipe.filter((p) => !naBancada.has(p.id));

          return (
            <Card key={w.id} title={w.name}>
              <div className="flex flex-wrap gap-2 mb-3">
                {w.capabilities.kanban && <Badge tone="info">Ordens de serviço</Badge>}
                {w.capabilities.parts && <Badge tone="info">Estoque de peças</Badge>}
                {temPlaquinha &&
                  (w.capabilities.equipmentTags ? (
                    <Badge tone="success">Plaquinha do equipamento</Badge>
                  ) : (
                    <Badge tone="neutral">Sem plaquinha</Badge>
                  ))}
              </div>

              {temPlaquinha && (
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0">
                  {w.capabilities.equipmentTags
                    ? 'O aparelho fica na oficina: a plaquinha é como se acha e como o cliente acompanha.'
                    : 'O aparelho entra e sai: a própria OS identifica, e a plaquinha não é emitida aqui.'}
                </p>
              )}

              <p className="font-semibold m-0 mt-3">Identidade dos documentos</p>
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0">
                É este nome que sai impresso na Ordem de Serviço que o cliente leva.
              </p>
              {empresas.length === 0 ? (
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Assina como{' '}
                  <strong>{marcas[w.id]?.brandName ?? 'a própria operação'}</strong>. Para trocar, é
                  preciso enxergar as operações do grupo.
                </p>
              ) : (
                <label className="flex flex-wrap items-center gap-2 my-2">
                  <span className="text-[length:var(--gs-text-sm)]">Assina como</span>
                  <select
                    value={marcas[w.id]?.brandCompanyId ?? ''}
                    onChange={(e) => void trocarMarca(w.id, e.target.value || null)}
                    aria-label={`Identidade impressa da bancada ${w.name}`}
                    className="h-[44px] px-3 rounded-[var(--gs-radius)] border
                      border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                      text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
                  >
                    <option value="">Em nome próprio</option>
                    {empresas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.tradeName || c.legalName}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <p className="font-semibold m-0 mt-3">Na bancada</p>
              {daBancada.length === 0 ? (
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Ninguém vinculado. Sem vínculo, o mecânico não enxerga esta oficina — pertencer à
                  operação não basta.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2 my-2">
                  {daBancada.map((m) => (
                    <span
                      key={m.id}
                      className="inline-flex items-center gap-2 px-2 py-1 rounded-[var(--gs-radius)]
                        border border-[var(--gs-border)]"
                    >
                      {m.display_name}
                      <button
                        type="button"
                        aria-label={`Tirar ${m.display_name} da bancada`}
                        onClick={() => void remover(w.id, m.user_id)}
                        className="bg-transparent border-0 cursor-pointer text-[var(--gs-danger)]"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {disponiveis.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center mt-2">
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Incluir:</span>
                  {disponiveis.slice(0, 8).map((p) => (
                    <Button
                      key={p.id}
                      size="sm"
                      variant="ghost"
                      onClick={() => void incluir(w.id, p.id)}
                    >
                      {p.displayName}
                    </Button>
                  ))}
                </div>
              )}
            </Card>
          );
        })
      )}
    </AppShell>
  );
}
