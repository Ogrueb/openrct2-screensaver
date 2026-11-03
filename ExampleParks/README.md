# Example parks

`playlists/example.toml` (and the test playlists next to it) play ten parks published on
[New Element Designs](https://www.nedesigns.com/). The park files are their builders' work and are
not part of this repository: download each one from its page below and put the zip, unrenamed,
in this folder. The playlists refer to the zips by the file names NE gives them.

| File in this folder | Park | Builders | Released |
|---|---|---|---|
| `230116-rct2-lurker-tin_train.zip` | [Tin Train](https://www.nedesigns.com/park/tin-train) | Lurker | 2023-01-16 |
| `220710-rct2-j_k-ghillie_dhu.zip` | [Ghillie Dhu](https://www.nedesigns.com/park/ghillie-dhu) | J K | 2022-07-11 |
| `230118-rct2-xtreme97-the_koi_pond.zip` | [The Koi Pond](https://www.nedesigns.com/park/the-koi-pond) | Xtreme97 | 2023-01-18 |
| `230206-rct2-xtreme97-qhyre_rock.zip` | [Qhyre Rock](https://www.nedesigns.com/park/qhyre-rock) | Xtreme97 | 2023-02-07 |
| `231026-rct2-jens_j-san_avaiki.zip` | [San Avaiki](https://www.nedesigns.com/park/san-avaiki) | Jens J. | 2023-10-26 |
| `240430-rct2wwtt-collabo-troubadours_et_baladins.zip` | [Troubadours et Baladins](https://www.nedesigns.com/park/troubadours-et-baladins) | Babar Tapie, MK98, Lurker, Louis! | 2024-04-30 |
| `240502-rct2tt-collabo-constellations.zip` | [Constellations](https://www.nedesigns.com/park/constellations) | J K, deanosrs, SSSammy, CHE | 2024-05-02 |
| `240512-rct2-jens_j-fkcoastermind-hex-sambhavas_rest.zip` | [Sambhava's Rest](https://www.nedesigns.com/park/sambhavas-rest) | Jens J., FK+Coastermind, Hex | 2024-05-12 |
| `240804-rct2ww-hoobaroo-alex-a_n_d_r_e_w-gardens_of_light.zip` | [Gardens of Light](https://www.nedesigns.com/park/gardens-of-light) | hoobaroo, alex, A n d r e w | 2024-08-04 |
| `240818-rct2-collabo-sonnental.zip` | [Sonnental](https://www.nedesigns.com/park/sonnental) | Liampie, MorganFan, Ulvenwood, roygbiv | 2024-08-18 |

What the repository keeps about them is derived data only: the analysis in `docs/example-parks.md`,
the per-park profiles in `parks/`, the tuning notes, and the names and builders from the NE catalog
(`tools/data/nedesigns.json`). Two of the parks ship a companion plugin in their zip (Animator in
Sambhava's Rest, Object Animator in Constellations); `mksequence.py --install` copies those scripts
into your own OpenRCT2 plugin folder, never into the repository.

The folder is listed in `.gitignore` apart from this file, so the zips stay local.
