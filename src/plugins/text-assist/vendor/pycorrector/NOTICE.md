# pycorrector data notice

Echo-8 vendors two lightweight character-confusion data files from
[pycorrector](https://github.com/shibing624/pycorrector), distributed under the
Apache License 2.0. The complete upstream license is retained in `LICENSE`.

| Local file | Upstream path | Last data commit | SHA-256 |
| --- | --- | --- | --- |
| `same_pinyin.txt` | `pycorrector/data/same_pinyin.txt` | `8f76475c3e5b3533b40e7ba41ca11ec987ffe974` | `39f9a93a68386ce63d23b97cdecf74ab4c381721b8bee68c854d64a2b5f21db0` |
| `same_stroke.txt` | `pycorrector/data/same_stroke.txt` | `41c5c177136370f8c3ab969d7d4a8a0fbef77288` | `c9e31dac045484b16f7f0704af1bd93d2cf841023e2e3a18a1181b413ec62d43` |

The build generator converts the tabular files into the readable
`[同音候选]` and `[形近候选]` sections of the canvas rule node. Echo-8 does not
ship pycorrector's Python runtime, KenLM model, word-frequency dictionary, or
personal/place-name datasets.
