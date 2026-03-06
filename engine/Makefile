CXX = g++
CXXFLAGS = -std=c++17 -O2 -fPIC -Wall -Wextra
TARGET = libgame_engine.so

all: $(TARGET)

$(TARGET): game_engine.cpp game_engine.h
	$(CXX) $(CXXFLAGS) -shared -o $(TARGET) game_engine.cpp -lm -lpthread

clean:
	rm -f $(TARGET)

.PHONY: all clean
