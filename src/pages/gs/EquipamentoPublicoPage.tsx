/**
 * A página que a plaquinha abre.
 *
 * O cliente escaneia o QR colado no equipamento e chega aqui — sem conta, sem
 * senha, na calçada. Até agora esse QR levava a lugar nenhum: a rota só existia
 * no roteador legado, inalcançável.
 *
 * A PLAQUINHA FICA EXPOSTA, e quem passa pode escanear. Por isso a página
 * mostra o aparelho e o andamento, e mais nada — o servidor nem envia dado do
 * dono, valor ou diagnóstico interno. Aqui só se exibe o que já chegou.
 *
 * Sem cabeçalho do sistema e sem menu: quem abre isto não é usuário do ERP.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiRequest, ApiRequestError, exigirCampos } from '@/lib/api/client';
import { dataBR } from '@/lib/datas';

interface PublicEquipment {
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  category: string | null;
  workshopName: string | null;
  companyName: string;
  inService: boolean;
  status: string | null;
  timeline: { step: string; at: string }[];
}

export default function EquipamentoPublicoPage() {
  const { token } = useParams<{ token: string }>();
  const [dados, setDados] = useState<PublicEquipment | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let ativo = true;
    void (async () => {
      try {
        const res = await apiRequest<PublicEquipment>(`/loja/equipamento/${token}`, {
          anonymous: true,
        }).then((r) => exigirCampos(r, 'publicIdLabel', 'brand', 'model', 'color', 'category', 'workshopName', 'companyName', 'inService', 'status', 'timeline'));
        if (ativo) setDados(res);
      } catch (err) {
        if (ativo) {
          setErro(
            err instanceof ApiRequestError && err.status === 404
              ? 'Não encontramos este equipamento.'
              : 'Não foi possível consultar agora.',
          );
        }
      }
    })();
    return () => {
      ativo = false;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-[var(--gs-canvas)] flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-lg">
        <p className="text-center font-bold text-[22px] tracking-tight m-0">GRUPO SAMPAIO</p>

        {erro && (
          <div className="mt-8 rounded-[var(--gs-radius)] border border-[var(--gs-border)] p-6 text-center">
            <p className="m-0 font-semibold">{erro}</p>
            <p className="m-0 mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Confira o código da plaquinha ou fale com a oficina.
            </p>
          </div>
        )}

        {dados && (
          <div className="mt-8 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
            bg-[var(--gs-surface)] p-6">
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {dados.workshopName ?? dados.companyName}
            </p>
            <p className="m-0 text-[32px] font-bold leading-none">{dados.publicIdLabel}</p>
            <p className="m-0 mt-2 text-[length:var(--gs-text-lg)]">
              {[dados.brand, dados.model, dados.color].filter(Boolean).join(' · ') ||
                'Equipamento'}
            </p>

            <div
              className={`mt-5 px-4 py-3 rounded-[var(--gs-radius)] font-semibold ${
                dados.inService
                  ? 'bg-[var(--gs-purple-700)] text-white'
                  : 'bg-[var(--gs-surface-hover)]'
              }`}
            >
              {/*
                Sem ordem de serviço não se inventa andamento: dizer "em
                serviço" para um aparelho que ninguém pegou seria mentira, e o
                cliente viria cobrar.
              */}
              {dados.status ?? 'Sem serviço em andamento'}
            </div>

            {dados.timeline.length > 0 && (
              <ol className="list-none p-0 mt-5 m-0">
                {dados.timeline.map((e, i) => (
                  <li
                    key={`${e.step}-${i}`}
                    className="flex justify-between gap-4 py-2 border-t border-[var(--gs-border)]"
                  >
                    <span>{e.step}</span>
                    <span className="text-[var(--gs-muted)] whitespace-nowrap">
                      {dataBR(e.at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            <div className="mt-6 pt-5 border-t border-[var(--gs-border)] flex flex-col gap-3">
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                É o dono deste equipamento? Na sua conta você abre um chamado, acompanha a ordem
                de serviço e vê os valores.
              </p>
              {/*
                O elo do QR: a plaquinha leva DIRETO à ficha deste aparelho
                na conta do dono — quem entra não precisa procurar a moto
                na lista.
              */}
              <Link
                to={`/minha-conta/equipamentos?equipamento=${encodeURIComponent(dados.publicIdLabel)}`}
                className="self-start no-underline text-white text-[length:var(--gs-text-sm)] font-semibold
                  rounded-[var(--gs-radius)] px-4 py-2"
                style={{ background: 'var(--gs-header-gradient)' }}
              >
                Entrar na minha conta
              </Link>
              <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                Esta página, aberta pela plaquinha, mostra só o andamento — sem dados do dono nem
                valores.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
