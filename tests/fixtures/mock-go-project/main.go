package main

import "fmt"

// Mock Go application for CLEO release system testing
// Task: T2674

const Version = "1.0.0"
const Name = "cleo-test-mock-go"

func main() {
	fmt.Printf("%s v%s\n", Name, Version)
	fmt.Println("Mock Go package for testing")
}

func Hello() string {
	return "Mock Go package"
}
