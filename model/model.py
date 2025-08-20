import torch
import torch.nn as nn

class FlowNet(nn.Module):
    def __init__(self, base=16):
        super().__init__()
        
        self.flow_net = nn.Sequential( 
            
            nn.Conv2d(6, base, kernel_size=4, stride=2, padding=1), nn.ReLU(True),
            nn.Conv2d(base, base*2, kernel_size=4, stride=2, padding=1), nn.ReLU(True),
            nn.Conv2d(base*2, base*4, kernel_size=4, stride=2, padding=1), nn.ReLU(True),
            nn.Conv2d(base*4, 4, kernel_size=4, stride=2, padding=1),
            
            nn.Upsample(scale_factor=2, mode='bilinear', align_corners=True),
            nn.Upsample(scale_factor=2, mode='bilinear', align_corners=True),
            nn.Upsample(scale_factor=2, mode='bilinear', align_corners=True),
            nn.Upsample(scale_factor=2, mode='bilinear', align_corners=True),
        )
        
        self.mask_head = nn.Sequential(
            nn.Conv2d(4, 1, kernel_size=3, stride=1, padding=1),
            nn.Sigmoid()
        )
        
    @torch.no_grad()
    def inference(self, img0, img1):
        x = torch.cat([img0, img1], dim=1)
        flow = self.flow_net(x)
        mask = self.mask_head(flow)
        return flow, mask
