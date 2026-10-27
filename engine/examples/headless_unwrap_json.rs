use barista::{unwrap, Params, PartIn};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Input { parts: Vec<PartIn>, #[serde(default)] params: Params }
#[derive(Serialize)]
struct ResultOut { names: Vec<String>, output: barista::Output }

fn main() {
    let input: Input = serde_json::from_slice(&std::fs::read(std::env::args().nth(1).expect("input json")).unwrap()).unwrap();
    let names = input.parts.iter().map(|p| p.name.clone()).collect();
    let output = unwrap(&input.parts, input.params).unwrap();
    std::fs::write(std::env::args().nth(2).expect("output json"), serde_json::to_vec(&ResultOut { names, output }).unwrap()).unwrap();
}
