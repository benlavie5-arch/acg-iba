# Moving the two existing mocks across

Yahil's and Abraham's mocks are in `data/roster.json`. Once the backend is up
I'll generate the insert statements from that file so nothing is retyped and
no score changes in the move.

Nothing is deleted from `roster.json` during the switch. It stays in git as a
record until the backend is confirmed working, then it comes out of the repo
so scores are no longer served publicly.
