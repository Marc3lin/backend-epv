import path from "node:path";

export const rootDir = path.resolve(process.cwd(), "..");

const media = (value: string, caption: string, options: { fit?: "cover" | "contain"; position?: string; featured?: boolean } = {}) => ({
  src: value,
  caption,
  ...options
});

export const siteAssets = {
  logoDark: "/media/logos/logo%20preta.png",
  logoLight: "/media/logos/logo%20branca.png",
  headerLogo: "/media/logos/logo_header_crisp.png",
  heroLogo: "/media/logos/logo_arena_epv_grande.png",
  hero: "/media/fotos/ChatGPT%20Image%2017%20de%20mai.%20de%202026%2C%2021_17_58.png",
  location: "/media/localiza%C3%A7%C3%A3o/foto%20da%20frente.png",
  courts: {
    "areia-1": "/media/quadra%20de%20areia/quadra%201%20areia.png",
    "areia-2": "/media/quadra%20de%20areia/quadra%202%20areia.png",
    "piso-volei": "/media/foto%20quadras%20de%20volei%20e%20futsal%20de%20piso/quadra%20laranja%20de%20volei%20foto%202.jpg",
    "piso-multi": "/media/foto%20quadras%20de%20volei%20e%20futsal%20de%20piso/foto%20quadra%20volei%20e%20futsal%20azul.webp"
  },
  teams: {
    kopa: "/media/Kopa%20(volei%20de%20praia)/logo%20kopa/logo%20kopa.png",
    futsal: "/media/futsal%20epv/logo%20futsal%20epv/logo.png",
    volleytech: "/media/equipes%20volleytech%20(volei%20de%20quadra)/logo%20volleytech/logo%20volei.png"
  }
};

export const teamPages = [
  {
    slug: "kopa",
    name: "Kopa Aulas de Praia",
    category: "Vôlei de praia",
    tagline: "Aulas de vôlei de praia para iniciantes, intermediários e atletas avançados.",
    contact: "(53) 98129-0067",
    teachers: ["Professor Kopa", "Professora Maria"],
    logo: siteAssets.teams.kopa,
    hero: "/media/Kopa%20(volei%20de%20praia)/torneio%20misto/foto%20de%20todos%20do%20podio.jpg",
    summary: "A Kopa é o projeto de vôlei de praia da Arena EPV. Une treino técnico, evolução individual e eventos competitivos na areia, sempre com ambiente próximo e energia de comunidade.",
    highlights: ["Aulas na areia em Pelotas", "Do iniciante ao avançado", "Torneios e circuitos próprios", "Professores Kopa e Maria"],
    sections: [
      {
        title: "Treinos e professores",
        text: "A base da Kopa são aulas práticas, progressivas e voltadas ao desenvolvimento real do atleta. Os professores acompanham técnica, posicionamento, leitura de jogo e rotina de evolução.",
        media: [
          media("/media/Kopa%20(volei%20de%20praia)/professor%20kopa.jpg", "Professor Kopa", { featured: true }),
          media("/media/Kopa%20(volei%20de%20praia)/professora%20maria.jpg", "Professora Maria", { position: "center 32%", featured: true })
        ]
      },
      {
        title: "Circuito Kopa",
        text: "A primeira etapa do Circuito Kopa reuniu duplas em jogos intensos, disputas equilibradas e alto nível técnico. Um formato criado para fortalecer a cena do vôlei de praia dentro da Arena.",
        media: [
          media("/media/Kopa%20(volei%20de%20praia)/primeira%20etapa%20do%20circuito%20kopa/vencedoras%20s%C3%A9rie%20ouro.jpg", "Vencedoras da série ouro"),
          media("/media/Kopa%20(volei%20de%20praia)/primeira%20etapa%20do%20circuito%20kopa/vencedores%20s%C3%A9rie%20ouro.jpg", "Vencedores da série ouro"),
          media("/media/Kopa%20(volei%20de%20praia)/primeira%20etapa%20do%20circuito%20kopa/vencedoras%20s%C3%A9rie%20prata.jpg", "Vencedoras da série prata"),
          media("/media/Kopa%20(volei%20de%20praia)/primeira%20etapa%20do%20circuito%20kopa/vencedores%20s%C3%A9rie%20prata.jpg", "Vencedores da série prata")
        ]
      },
      {
        title: "Torneio misto",
        text: "Um dia de jogos intensos, parceria e muita entrega na areia. O torneio misto mostra a Kopa como espaço de competição, convivência e celebração do esporte.",
        media: [
          media("/media/Kopa%20(volei%20de%20praia)/torneio%20misto/primeiro%20lugar.jpg", "Primeiro lugar"),
          media("/media/Kopa%20(volei%20de%20praia)/torneio%20misto/segundo%20lugar.jpg", "Segundo lugar"),
          media("/media/Kopa%20(volei%20de%20praia)/torneio%20misto/terceiro%20lugar.jpg", "Terceiro lugar"),
          media("/media/Kopa%20(volei%20de%20praia)/torneio%20misto/video%20demonstrando%20o%20torneio.mp4", "Vídeo do torneio misto", { featured: true })
        ]
      }
    ]
  },
  {
    slug: "futsal-epv",
    name: "Futsal EPV",
    category: "Escola de futsal e fut 7",
    tagline: "Formação esportiva, competição e desenvolvimento de atletas dentro e fora de quadra.",
    contact: "(53) 98113-1908",
    teachers: ["Professor Vinicius"],
    logo: siteAssets.teams.futsal,
    hero: "/media/futsal%20epv/campeonato%20fuutebol.jpg",
    summary: "O Futsal EPV é a escola de futsal e fut 7 da Arena, com matrículas abertas e foco em formação, disciplina, competitividade e desenvolvimento coletivo.",
    highlights: ["Escola de futsal e fut 7", "Matrículas abertas", "Categorias de base em competição", "Professor Vinicius"],
    sections: [
      {
        title: "Campeonato e identidade da equipe",
        text: "O registro de campeonato apresenta o projeto em sua frente competitiva: atletas uniformizados, identidade visual forte e presença da Arena como casa do futsal.",
        media: [
          media("/media/futsal%20epv/campeonato%20fuutebol.jpg", "Arte principal de campeonato do Futsal EPV", { fit: "contain", featured: true })
        ]
      },
      {
        title: "Sub-13 em competição",
        text: "A categoria Sub-13 estreou no Estadual da Liga Gaúcha com vitória por 5 a 4 e seguiu representando o EPV em jogos de alto nível. Estes registros contam a trajetória competitiva da equipe.",
        media: [
          media("/media/futsal%20epv/sub13%20vitoria.webp", "Sub-13 após vitória na estreia"),
          media("/media/futsal%20epv/Vice%20campe%C3%B5es%20na%20Carbonero%20Cub%20Sub%2013%20-%20Gua%C3%ADba.png", "Vice-campeões na Carbonero Cup Sub-13")
        ]
      },
      {
        title: "Classificação e bastidores",
        text: "A equipe encarou viagem, aquecimento, entrada em quadra e jogos decisivos até conquistar classificação para a terceira fase. Os vídeos ficam agrupados como bastidores da campanha.",
        media: [
          media("/media/futsal%20epv/epv%20futsal%20classificada%20fotos%20e%20videos/epv%20futsal%20classificado%20pra%20terceira%20fase%20sub13.webp", "Equipe classificada para a terceira fase", { featured: true }),
          media("/media/futsal%20epv/epv%20futsal%20classificada%20fotos%20e%20videos/entrando%20em%20quadra.mp4", "Entrada em quadra"),
          media("/media/futsal%20epv/epv%20futsal%20classificada%20fotos%20e%20videos/aquecimento.mp4", "Aquecimento"),
          media("/media/futsal%20epv/epv%20futsal%20classificada%20fotos%20e%20videos/aquecimento%20pre%20jogo.mp4", "Aquecimento pré-jogo")
        ]
      },
      {
        title: "Elenco em ação",
        text: "Fotos individuais e de jogo mostram os atletas que constroem o projeto no dia a dia.",
        media: [
          media("/media/futsal%20epv/jogadores/goleiro.jpg", "Goleiro do EPV"),
          media("/media/futsal%20epv/jogadores/lentesporgabrielscursone-3880502948942131144_52267614986_1-20260421_195341.jpg", "Atleta em quadra"),
          media("/media/futsal%20epv/jogadores/lentesporgabrielscursone-3880502948942131144_52267614986_3-20260421_195341.jpg", "Disputa de jogo"),
          media("/media/futsal%20epv/jogadores/lentesporgabrielscursone-3880502948942131144_52267614986_4-20260421_195341.jpg", "Jogador do EPV")
        ]
      }
    ]
  },
  {
    slug: "volleytech",
    name: "VolleyTech",
    category: "Vôlei de quadra",
    tagline: "Mais que um time: uma família em evolução dentro do vôlei de quadra.",
    contact: "+55 53 98102-9741",
    teachers: ["Professor Nicolas", "Professor GB"],
    logo: siteAssets.teams.volleytech,
    hero: "/media/equipes%20volleytech%20(volei%20de%20quadra)/noticias%20equipe%20volei/final%20de%20semana%20em%20quadra.webp",
    summary: "A VolleyTech representa o vôlei de quadra da Arena EPV, com equipes, rotina de treinos, calendário de jogos e notícias que registram a evolução do projeto.",
    highlights: ["Equipe masculina e feminina", "Treinos organizados", "Competições e estreias", "Professores Nicolas e GB"],
    sections: [
      {
        title: "Horários de treino",
        text: "A arte de horários é informação operacional importante para quem quer entrar na equipe. Por isso ela aparece destacada, inteira e sem corte.",
        media: [
          media("/media/equipes%20volleytech%20(volei%20de%20quadra)/horarios%20equipe%20masculina%20e%20feminina/imageye___-_imgi_60_610551390_17956025154028815_8769746022945427336_n.jpg", "Horários das equipes masculina e feminina", { fit: "contain", featured: true })
        ]
      },
      {
        title: "Notícias e competições",
        text: "As imagens renomeadas como notícias mostram os momentos mais importantes do projeto: estreia dupla, conquistas, nova equipe feminina e participação em campeonatos.",
        media: [
          media("/media/equipes%20volleytech%20(volei%20de%20quadra)/noticias%20equipe%20volei/volleytech%20tem%20estreia%20dupla%20nesse%20domingo.webp", "Estreia dupla da VolleyTech", { fit: "contain" }),
          media("/media/equipes%20volleytech%20(volei%20de%20quadra)/noticias%20equipe%20volei/conquistas%20volleytech.png", "Conquistas da VolleyTech", { fit: "contain" }),
          media("/media/equipes%20volleytech%20(volei%20de%20quadra)/noticias%20equipe%20volei/nova%20equipe%20feminina.webp", "Nova equipe feminina", { fit: "contain" }),
          media("/media/equipes%20volleytech%20(volei%20de%20quadra)/noticias%20equipe%20volei/primeira%20edicao%20campeonato%20lpv%20volei.jpg", "Primeira edição do campeonato LPV", { fit: "contain" })
        ]
      },
      {
        title: "Final de semana em quadra",
        text: "Registro de grupo e presença competitiva: a VolleyTech como time, comunidade e rotina dentro da Arena.",
        media: [
          media("/media/equipes%20volleytech%20(volei%20de%20quadra)/noticias%20equipe%20volei/final%20de%20semana%20em%20quadra.webp", "Final de semana em quadra", { fit: "contain", featured: true }),
          media("/media/equipes%20volleytech%20(volei%20de%20quadra)/video%20de%20pessoas%20que%20cairam%20no%20chao%20(video%20engra%C3%A7ado)/quedas.jpg", "Bastidor leve da equipe", { fit: "contain" })
        ]
      }
    ]
  }
];
