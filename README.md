# LibruSchedule

Terminalowy klient planu lekcji z dziennika Librus Synergia. Loguje się na Twoje konto, pobiera plan na wybrany tydzień razem z godzinami dzwonków, nauczycielami, salami i wpisami z terminarza, po czym wyświetla wszystko jako czytelną tabelę w konsoli.

Program działa na macOS, Windows i Linuksie. Hasła trafiają do pęku kluczy systemu (Keychain, DPAPI, libsecret), a gdy nie jest on dostępny - do zaszyfrowanego pliku konfiguracyjnego. Obsługuje wiele kont i przełączanie się między nimi.

## Wymagania

- Node.js 20.11 lub nowszy
- pnpm (opcjonalnie, wystarczy npm)
- konto ucznia lub rodzica w Librus Synergia

## Instalacja i uruchomienie

```bash
git clone https://github.com/krzysztofgas/libruschedule.git
cd libruschedule
pnpm install
pnpm start
```

Przy pierwszym uruchomieniu program poprosi o login i hasło do Synergii, zweryfikuje je i zapisze konto. Potem wystarczy samo `pnpm start` - pojawi się menu sterowane strzałkami.

## Użycie

```bash
node index.js                    # tryb interaktywny (menu)
node index.js --next             # plan na następny tydzień
node index.js --date 2026-09-21  # tydzień zawierający podany dzień
node index.js --account "Jan"    # wybór zapisanego konta
node index.js --help             # pełna lista opcji
```

Zamiast zapisanego konta można użyć zmiennych środowiskowych `LIBRUS_LOGIN` i `LIBRUS_PASSWORD`, co przydaje się w skryptach.

## Uwagi

Projekt korzysta z nieoficjalnej biblioteki [librus-api](https://github.com/Mati365/librus-api), która parsuje stronę Synergii. Nie jest w żaden sposób powiązany z firmą Librus. Używaj go wyłącznie na własnym koncie i bez odpytywania serwera w pętli.

## Licencja

ISC
