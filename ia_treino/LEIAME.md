# Treino da IA dos produtos (PC com placa de vídeo)

1. Na aba **IA** do painel, clique em **Exportar pacote** e baixe o `dataset_yolo.zip`.
2. Descompacte numa pasta, por exemplo `C:\ia\dataset`.
3. Instale o Python 3.11/3.12, o PyTorch com CUDA (https://pytorch.org, escolha Windows + CUDA) e depois `pip install ultralytics`.
4. Rode:

   ```
   python treinar.py C:\ia\dataset C:\ia\treinos\2026-11-04
   ```

   Parâmetros fixos por padrão (100 épocas, até 150 fotos sem produto, `yolo11s.pt`, imagem 960 px), para que
   treinos futuros, com mais fotos, sejam comparáveis. Cada treino acrescenta uma linha em `C:\ia\treinos\historico.csv`.

5. Resultado: `resultado.json` (mAP por produto), `run\weights\best.pt` (o modelo) e `previsoes\` (fotos de validação com as caixas).

O que olhar: **mAP50** (0 a 1; acima de 0,7 já é bom) e o `por_classe` — produtos com menos de ~20 marcações
costumam ficar perto de zero; é aí que vale tirar mais fotos.
