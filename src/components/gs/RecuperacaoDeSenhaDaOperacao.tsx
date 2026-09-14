/**
 * A ESCOLHA DO DONO: a equipe desta operação pode trocar a própria senha pelo
 * e-mail? — GAP-PRD-160.
 *
 * Padrão DESLIGADO: sem escolha, nada muda (só a gestão redefine senha). O
 * cartão aparece só para quem responde pelo grupo (`admin_geral`, `gestor`),
 * que é quem o servidor aceita no PUT, e diz as regras que o servidor aplica:
 * conta de dono nunca recupera por e-mail, e a pessoa que trabalha em várias
 * operações só recupera se todas ligarem. Sem SMTP, o cartão avisa: o código
 * espera na fila e a tela de entrada não oferece o caminho.
 */
import { useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/gs/ui';
import { useHasProfile } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { recuperacaoApi, type RecuperacaoDaOperacao } from '@/lib/api/recuperacaoDeSenha';

export function RecuperacaoDeSenhaDaOperacao() {
  // Sem perfil extra: só os donos do grupo passam (o atalho de useHasProfile).
  const dono = useHasProfile();
  const [estado, setEstado] = useState<RecuperacaoDaOperacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    if (!dono) return;
    let vivo = true;
    recuperacaoApi
      .daOperacao()
      .then((r) => {
        if (vivo) setEstado(r);
      })
      .catch(() => {
        if (vivo) setEstado(null);
      });
    return () => {
      vivo = false;
    };
  }, [dono]);

  if (!dono || !estado) return null;

  const alternar = async () => {
    setErro(null);
    setOcupado(true);
    try {
      setEstado(await recuperacaoApi.definir(!estado.emailLigado));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível salvar a escolha.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="mb-5">
      <Card title="Recuperação de senha pela própria pessoa">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <Badge tone={estado.emailLigado ? 'success' : 'neutral'}>
            {estado.emailLigado ? 'LIGADA NESTA OPERAÇÃO' : 'DESLIGADA — SÓ A GESTÃO REDEFINE'}
          </Badge>
          <Button variant="secondary" onClick={() => void alternar()} disabled={ocupado}>
            {estado.emailLigado ? 'Desligar' : 'Ligar'}
          </Button>
        </div>
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          Ligada, quem trabalha nesta operação e tem e-mail cadastrado pode pedir, na tela de
          entrada, um código de uso único (vale 15 minutos) e trocar a própria senha. Contas de
          administrador, gestor e contador nunca recuperam por e-mail. Quem também trabalha em
          outra operação só recupera se a recuperação estiver ligada em todas elas.
        </p>
        {!estado.carteiroPronto && (
          <p
            data-testid="recuperacao-sem-smtp"
            className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
          >
            O e-mail de saída ainda não está configurado
            {estado.faltaNoCarteiro.length > 0 ? ` (falta: ${estado.faltaNoCarteiro.join(', ')})` : ''}.
            Até lá o código espera na fila, e a tela de entrada não oferece o caminho.
          </p>
        )}
        {erro && (
          <p role="alert" className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
            {erro}
          </p>
        )}
      </Card>
    </div>
  );
}
