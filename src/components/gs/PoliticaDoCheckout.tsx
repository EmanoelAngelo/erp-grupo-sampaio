/**
 * "Quem pode comprar na loja online" — a decisão do dono (GAP-PRD-028).
 *
 * Comprar exige conta por padrão: é o que põe o pedido na conta do cliente,
 * pede o cadastro completo antes de fechar e impede que o CPF digitado por
 * alguém ache o cadastro de outra pessoa. A loja que quiser vender também para
 * visitante liga aqui — e o servidor registra quem trocou, de quê para quê.
 *
 * Componente próprio, e não mais um campo do "Salvar" da vitrine: é outra
 * decisão, com outro peso, e gravar junto com a chamada da vitrine faria uma
 * troca de texto abrir a loja para visitante sem ninguém perceber.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { checkoutPolicyApi, type ModoDoCheckout, type PoliticaDoCheckout } from '@/lib/api/checkoutPolicy';

const OPCOES: { id: ModoDoCheckout; rotulo: string; efeito: string }[] = [
  {
    id: 'conta',
    rotulo: 'Só com conta (recomendado)',
    efeito:
      'O cliente entra ou cria a conta antes de fechar. O pedido fica na conta dele, com nome, CPF/CNPJ e telefone conferidos, e o endereço salvo pode ser usado.',
  },
  {
    id: 'visitante',
    rotulo: 'Também sem conta (visitante)',
    efeito:
      'Quem não tem conta fecha o pedido digitando os dados. O pedido só aparece numa conta depois que o cliente confirmar o mesmo e-mail que digitou.',
  },
];

export function PoliticaDoCheckoutCard() {
  const [politica, setPolitica] = useState<PoliticaDoCheckout | null>(null);
  const [escolha, setEscolha] = useState<ModoDoCheckout>('conta');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const p = await checkoutPolicyApi.obter();
      setPolitica(p);
      setEscolha(p.mode);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não deu para ler quem pode comprar.');
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
      const p = await checkoutPolicyApi.definir(escolha);
      setPolitica(p);
      setAviso(
        p.mode === 'conta'
          ? 'Salvo. A partir de agora, comprar nesta loja exige conta.'
          : 'Salvo. A loja passa a aceitar também quem compra sem conta.',
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card
      title="Quem pode comprar"
      subtitle="Decide se a loja online exige que o cliente entre na conta para fechar o pedido. A troca fica registrada na auditoria."
    >
      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)] mt-0">
          {erro}
        </p>
      )}
      {politica && (
        <>
          {!politica.configurado && (
            <p className="mt-0 mb-3">
              <Badge tone="info">Valendo o padrão: só com conta</Badge>
            </p>
          )}
          <fieldset className="border-0 p-0 m-0 flex flex-col gap-3">
            <legend className="sr-only">Quem pode comprar</legend>
            {OPCOES.map((o) => (
              <label key={o.id} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="modo-do-checkout"
                  value={o.id}
                  checked={escolha === o.id}
                  onChange={() => setEscolha(o.id)}
                  className="mt-1"
                />
                <span>
                  <strong className="block text-[length:var(--gs-text-sm)]">{o.rotulo}</strong>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {o.efeito}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button
            onClick={() => void salvar()}
            loading={ocupado}
            disabled={escolha === politica.mode && politica.configurado}
            className="mt-3"
          >
            Salvar quem pode comprar
          </Button>
          {aviso && (
            <p role="status" className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)] mb-0">
              {aviso}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
