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

## Pamięć podręczna

Pobrany plan jest zapisywany lokalnie, więc kolejne uruchomienia wyświetlają go natychmiast, bez logowania. Program pilnuje świeżości danych sam: wpis wygasa po 15 minutach w godzinach lekcyjnych i po 3 godzinach poza nimi, a przed użyciem starszych danych sprawdza liczniki powiadomień w dzienniku - terminarz pobiera ponownie tylko wtedy, gdy coś się w nim zmieniło. Po odświeżeniu pod tabelą pojawia się lista zmian, na przykład zastępstwo albo odwołana lekcja. Gdy nie ma połączenia z Synergią, wyświetlany jest ostatni zapisany plan z ostrzeżeniem.

Flagi `--refresh` (pobranie na nowo), `--no-cache` (bez zapisu i odczytu) i `--clear-cache` (wyczyszczenie) dają pełną kontrolę; w menu można też nacisnąć `r` przy wyświetlonym planie.

## Uwagi

Projekt korzysta z nieoficjalnej biblioteki [librus-api](https://github.com/Mati365/librus-api), która parsuje stronę Synergii. Nie jest w żaden sposób powiązany z firmą Librus. Używaj go wyłącznie na własnym koncie i bez odpytywania serwera w pętli.

## Licencja

ISC
