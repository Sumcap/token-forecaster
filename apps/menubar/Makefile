APP := .build/TokenForecaster.app

.PHONY: all release build bundle dist run clean

all: release

## release: build the binary and assemble the .app bundle
release: bundle

build:
	swift build -c release

bundle:
	./build-app.sh

## dist: build everything and produce a shareable, self-contained zip
dist:
	./build-dist.sh

## run: (re)build and launch the menu bar app
run: release
	open $(APP)

clean:
	rm -rf .build
