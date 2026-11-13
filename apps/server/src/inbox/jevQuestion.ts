export const qualificationQuestion = {
  qualification: {
    type: "choice",
    instructions:
      "Classifie uniquement le message courant state.message pour state.current_user. state.context contient des messages antérieurs servant seulement à comprendre le message courant : ne les requalifie pas et n'hérite pas automatiquement de leurs actions. Dans un email, message.quoted_text est une citation antérieure, pas une nouvelle demande. Un transfert cite un autre échange : ses pronoms ne désignent pas automatiquement Valentin. Les fichiers image sont signalés dans message.files mais tu n'en as pas le contenu visuel : utilise unsure si ce contenu est nécessaire, pour permettre au Chef de le lire. Distingue une action demandée à Valentin ou un engagement de Valentin d'une action confiée à quelqu'un d'autre. Une résolution, une annulation ou une réattribution utile à une tâche est une information, pas une action encore à faire. Une réponse de politesse sans information nouvelle est no_action. Si le message courant contient aussi une action explicite pour Valentin, retiens la catégorie d'action appropriée. N'invente pas le contexte manquant.",
    criteria: {
      no_action:
        "Discussion, politesse ou échange sans action pour Valentin et sans information utile à conserver.",
      information:
        "Information utile à Valentin, à un sujet ou à une tâche, sans action personnelle ou technique à accomplir par Valentin dans ce message. Inclut une résolution, une annulation ou une réattribution.",
      personal_action:
        "Action personnelle demandée à Valentin ou engagement personnel de Valentin, sans lien avec son travail.",
      technical_action:
        "Action professionnelle à effectuer sur PC par Valentin, demandée ou à laquelle il s'engage : développement, infrastructure, Notion, Excel, etc.",
      unsure:
        "Le contexte est insuffisant ou ambigu pour déterminer la nature du message, son action ou son destinataire sans inventer.",
    },
  },
} as const;
