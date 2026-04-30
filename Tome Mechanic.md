# The Tome
The idea behind the Tome is that the Familiar's entire core is local and independent of chat context.

The idea is to replicate how humans retain knowledge and growth even if they forget where they *learned* the knowledge or how they achieved that growth. Aside from that, the Familiar can do better agentic work and adapt better to current situations if as little as possible of their ongoing knowledge is in the current context.

## Knowledge Storage
When knowledge is acquired or expanded, it gets stored in a database. Not as snippets of the chat conversation, but in somewhat more summarized fashion. For example:
```
User: Oh God, I think I'm going to be late
Familiar: [checks calendar, sees that today is just a casual meetup with friends]
Familiar: Is that awful? It's just a casual meetup, right? And your friends will likely be nice about it?
User: Yeah but being late always stresses me out. I feel so guilty about it.
Familiar: [writes to database: "Being late stresses user out, even if the stakes are low. It causes them a lot of guilt."]
```

This is only the actual content. The entry will have other fields - keywords, logic, etc.

One potentially useful field could be "Learned: DD/MM/YYYY, HH:MM" so the Familiar can retrieve the conversation context if need be.

## Knowledge Retrieval
Knowledge retrieval will need to work depending on the established triggers.

Some entries will be activated by keywords. For example: 
```
"Birb is User's significant other. They work [job] and are [age] years old, and they live in the same city but at a 40 minute distance by public transport. Valid emergency contact."
```

Could be tied to keywords like `Birb, boyfriend, girlfriend, romantic relationship, partner, significant other` so it will always be pulled up in that context.

