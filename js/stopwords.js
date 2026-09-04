// Listes de mots vides (stopwords) minimales, utilisées pour :
//  - la détection de langue (comptage de fréquence par langue)
//  - le filtrage des mots-clés (listes A et B, étapes 9 et 10)
// Volontairement compactes : suffisant pour du matching lexical "CPU", pas un dictionnaire complet.

export const STOPWORDS = {
  fr: new Set(`le la les un une des de du au aux et ou où qui que quoi dont
  ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs
  je tu il elle on nous vous ils elles se sa son ses en dans par pour avec sans sous sur
  entre vers chez contre depuis pendant avant après ainsi donc car mais si comme plus moins
  très bien tout tous toute toutes être avoir faire fait ai as a avons avez ont suis es est
  sommes êtes sont était étais étaient sera seront serait pas ne n' l' d' s' j' c' qu'
  afin ainsi alors aussi autre autres au-delà y a an ans année années notamment
  votre nos leurs celui celle ceux celles`.split(/\s+/).filter(Boolean)),

  en: new Set(`the a an of to and or in on at for with without under over between
  into from by as is are was were be been being this that these those it its it's
  you your yours we our ours they their theirs he she his her him them i my mine
  will would can could should shall may might must not no nor so than then there
  here what which who whom whose when where why how all any both each few more
  most other some such only own same too very s t just don should've now`.split(/\s+/).filter(Boolean)),

  es: new Set(`el la los las un una de del al y o que quien donde como para por con sin sobre
  entre desde hasta este esta estos estas mi tu su nuestro vuestro sus ser estar hacer`.split(/\s+/).filter(Boolean)),

  de: new Set(`der die das ein eine und oder von zu im am für mit ohne unter über zwischen
  ich du er sie es wir ihr sein haben werden nicht kein`.split(/\s+/).filter(Boolean)),

  it: new Set(`il lo la i gli le un uno una di da a in su per tra fra e o che chi dove come
  questo questa questi queste mio tuo suo nostro vostro loro essere avere fare`.split(/\s+/).filter(Boolean)),

  pt: new Set(`o a os as um uma de do da em no na para por com sem sobre entre este esta
  estes estas meu teu seu nosso vosso ser estar fazer e ou que quem onde como`.split(/\s+/).filter(Boolean)),
};

// Mots à exclure systématiquement des mots-clés même s'ils passent les autres filtres
// (coordonnées, formules type CV)
export const CONTACT_HINTS = [
  /@/, // email
  /https?:\/\//i,
  /www\./i,
  /\+?\d[\d .\-()]{6,}\d/, // numéro de téléphone
  /^(tel|téléphone|phone|email|e-mail|mail|adresse|address|linkedin|github|portfolio)\s*:?/i,
];
