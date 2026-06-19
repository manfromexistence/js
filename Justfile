set shell := ["pwsh.exe", "-c"]

build:
    cargo build --release -p bun_bin -j 12
    Copy-Item target\release\js.exe G:\Dx\bin\js.exe -Force
